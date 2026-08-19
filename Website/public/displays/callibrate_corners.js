// callibrate_corners.js - Corner calibration screen + raw -> grid coordinate mapping.
//
// No triangulation. The three ultrasonic sensors sit on one line, all pointing
// straight forward, so each sensor simply owns one COLUMN of the 3x3 board:
//
//        left sensor      centre sensor     right sensor
//            |                  |                 |
//        column 0           column 1          column 2
//
// Whichever sensor sees the player decides the column; that sensor's distance
// reading decides the row. 3 columns x 3 distance bands = the 9 grid cells.
//
// Grid space is what the game consumes: integers 0-2 on both axes, with (0, 0)
// at the BOTTOM-LEFT of the play area and (2, 2) at the TOP-RIGHT. "Bottom"
// means nearest the screen, so the alert zone sits just below row 0.
//
// Calibration captures the four corners to learn two things:
//   1. the near and far distance bounds, which are split into the three rows
//   2. whether the sensors are wired left-to-right or reversed
//
// API on `window`:
//   window.renderCalibrateCorners(ctx, canvas, reading) - draw the screen
//   window.getCalibrateCornersButtonAtPoint(canvas, x, y) - hit-test buttons
//   window.captureCorner(reading)          - store the active corner, advance
//   window.resetCornerCalibration()        - clear all four corners
//   window.isCornerCalibrationComplete()   - all four captured?
//   window.getCornerCalibration()          - inspect state (used by the HUD)
//   window.rawToGrid(column, distanceCm)   - raw fix -> { gx, gy, inside, calibrated }

(function () {
  // Capture order walks the perimeter so the operator moves the short way each time.
  const CORNER_ORDER = ["BL", "BR", "TR", "TL"];

  const CORNER_LABELS = {
    BL: "Bottom-Left",
    BR: "Bottom-Right",
    TR: "Top-Right",
    TL: "Top-Left",
  };

  // Used when sensor mode starts without a completed calibration, so the game
  // still responds instead of going dead.
  const DEFAULT_NEAR_CM = 20;
  const DEFAULT_FAR_CM = 90;

  // Slack beyond the calibrated near/far bounds still counted as on the board.
  const BAND_TOLERANCE_CM = 10;

  // A calibration whose near and far edges are this close together is a
  // mis-capture (e.g. all four corners taken from the same spot).
  const MIN_PLAY_DEPTH_CM = 15;

  const state = {
    corners: { BL: null, BR: null, TR: null, TL: null },
    activeIndex: 0,
  };

  function activeKey() {
    return CORNER_ORDER[state.activeIndex] || null;
  }

  function capturedCount() {
    return CORNER_ORDER.filter((key) => state.corners[key] !== null).length;
  }

  function isComplete() {
    return capturedCount() === CORNER_ORDER.length;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // Derives the usable calibration: the near/far distance bounds and whether
  // the sensor order is reversed. Falls back to defaults when incomplete or
  // when the captured corners do not describe a sane play area.
  function getBounds() {
    if (!isComplete()) {
      return { nearCm: DEFAULT_NEAR_CM, farCm: DEFAULT_FAR_CM, flipped: false, calibrated: false };
    }

    const { BL, BR, TR, TL } = state.corners;
    const nearCm = (BL.distanceCm + BR.distanceCm) / 2;
    const farCm = (TL.distanceCm + TR.distanceCm) / 2;

    if (!(farCm - nearCm >= MIN_PLAY_DEPTH_CM)) {
      return { nearCm: DEFAULT_NEAR_CM, farCm: DEFAULT_FAR_CM, flipped: false, calibrated: false, bad: true };
    }

    // If the bottom-left corner was picked up by a higher-numbered sensor than
    // the bottom-right one, the sensors are mounted/wired right-to-left.
    const flipped = BL.column > BR.column;

    return { nearCm, farCm, flipped, calibrated: true };
  }

  window.getCalibrationBounds = getBounds;

  // Raw fix -> play-area grid coordinate.
  //   column     - which sensor saw the player (0 left, 1 centre, 2 right)
  //   distanceCm - that sensor's distance reading
  // Returns integer gx/gy in 0..2, or null if the input is unusable.
  window.rawToGrid = function rawToGrid(column, distanceCm) {
    if (!Number.isInteger(column) || column < 0 || column > 2) return null;
    if (!Number.isFinite(distanceCm)) return null;

    const { nearCm, farCm, flipped, calibrated } = getBounds();

    const gx = flipped ? 2 - column : column;

    // Split the near..far depth into three equal rows.
    const span = farCm - nearCm;
    const t = (distanceCm - nearCm) / span;
    const gy = clamp(Math.floor(t * 3), 0, 2);

    const inside =
      distanceCm >= nearCm - BAND_TOLERANCE_CM && distanceCm <= farCm + BAND_TOLERANCE_CM;

    return { gx, gy, inside, calibrated, nearCm, farCm };
  };

  window.isCornerCalibrationComplete = isComplete;

  window.getCornerCalibration = function getCornerCalibration() {
    return {
      corners: { ...state.corners },
      activeKey: activeKey(),
      captured: capturedCount(),
      total: CORNER_ORDER.length,
      complete: isComplete(),
      ...getBounds(),
    };
  };

  window.resetCornerCalibration = function resetCornerCalibration() {
    CORNER_ORDER.forEach((key) => {
      state.corners[key] = null;
    });
    state.activeIndex = 0;
  };

  // Stores the current raw fix against the active corner and advances to the
  // next uncaptured corner. Returns false when the reading is unusable.
  window.captureCorner = function captureCorner(reading) {
    const key = activeKey();
    if (!key) return false;
    if (!reading || reading.status !== "ok") return false;
    if (!Number.isFinite(reading.distanceCm) || !Number.isInteger(reading.column)) return false;

    state.corners[key] = { column: reading.column, distanceCm: reading.distanceCm };

    const nextIndex = CORNER_ORDER.findIndex((k) => state.corners[k] === null);
    state.activeIndex = nextIndex === -1 ? CORNER_ORDER.length : nextIndex;
    return true;
  };

  window.getCalibrateCornersLayout = function getCalibrateCornersLayout(canvas) {
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const centerX = width / 2;

    const boxSize = Math.min(width * 0.4, height * 0.36, 320);
    const boxX = centerX - boxSize / 2;
    const boxY = Math.max(150, height * 0.25);

    const buttonWidth = Math.min(190, Math.max(130, width * 0.16));
    const buttonHeight = 48;
    const gap = 14;
    const row = [
      { type: "capture", label: "Capture" },
      { type: "reset", label: "Reset" },
      { type: "start", label: "Start Game" },
    ];
    const rowWidth = row.length * buttonWidth + (row.length - 1) * gap;
    const rowY = Math.min(height - buttonHeight - 28, boxY + boxSize + 120);

    return {
      width,
      height,
      centerX,
      boxX,
      boxY,
      boxSize,
      backButton: { type: "back", x: 16, y: 16, width: 80, height: 36, label: "◀ Back" },
      skipButton: { type: "skip", x: width - 96, y: 16, width: 80, height: 36, label: "Skip ▶" },
      buttons: row.map((button, index) => ({
        ...button,
        x: centerX - rowWidth / 2 + index * (buttonWidth + gap),
        y: rowY,
        width: buttonWidth,
        height: buttonHeight,
      })),
    };
  };

  function pointInRect(x, y, r) {
    return r && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
  }

  window.getCalibrateCornersButtonAtPoint = function getCalibrateCornersButtonAtPoint(canvas, x, y) {
    const layout = window.getCalibrateCornersLayout(canvas);

    if (pointInRect(x, y, layout.backButton)) return { type: "back" };
    if (pointInRect(x, y, layout.skipButton)) return { type: "skip" };

    const hit = layout.buttons.find((button) => pointInRect(x, y, button));
    if (!hit) return null;
    if (hit.type === "start" && !isComplete()) return null;
    return { type: hit.type };
  };

  // Corner marker positions inside the preview box, in screen space (y grows down).
  function cornerBoxPositions(layout) {
    const { boxX, boxY, boxSize } = layout;
    return {
      TL: { x: boxX, y: boxY },
      TR: { x: boxX + boxSize, y: boxY },
      BR: { x: boxX + boxSize, y: boxY + boxSize },
      BL: { x: boxX, y: boxY + boxSize },
    };
  }

  const COLUMN_NAMES = ["Left", "Centre", "Right"];

  window.renderCalibrateCorners = function renderCalibrateCorners(ctx, canvas, reading) {
    const layout = window.getCalibrateCornersLayout(canvas);
    const { width, height, centerX, boxX, boxY, boxSize } = layout;
    const key = activeKey();
    const complete = isComplete();
    const bounds = getBounds();

    ctx.fillStyle = "#13131c";
    ctx.fillRect(0, 0, width, height);

    [layout.backButton, layout.skipButton].forEach((btn) => {
      ctx.fillStyle = "#475569";
      ctx.fillRect(btn.x, btn.y, btn.width, btn.height);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 14px monospace";
      ctx.textAlign = "center";
      ctx.fillText(btn.label, btn.x + btn.width / 2, btn.y + 24);
    });

    // Title + instruction
    const titleY = Math.max(50, height * 0.08);
    ctx.textAlign = "center";
    ctx.fillStyle = "#f4f4f5";
    ctx.font = `bold ${Math.max(18, Math.min(32, width * 0.03))}px monospace`;
    ctx.fillText("Corner Calibration", centerX, titleY);

    ctx.font = `${Math.max(13, Math.min(18, width * 0.016))}px monospace`;
    ctx.fillStyle = complete ? "#22c55e" : "#9298aa";
    ctx.fillText(
      complete
        ? "All four corners captured - press Start Game"
        : `Stand at the ${CORNER_LABELS[key].toUpperCase()} corner, then press Capture`,
      centerX,
      titleY + 30
    );

    ctx.fillStyle = "#585b70";
    ctx.font = `${Math.max(12, Math.min(15, width * 0.013))}px monospace`;
    ctx.fillText(`${capturedCount()} / ${CORNER_ORDER.length} captured`, centerX, titleY + 52);

    // Play-area preview box
    ctx.strokeStyle = "#2b2f3d";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(boxX, boxY, boxSize, boxSize);
    ctx.setLineDash([]);

    ctx.fillStyle = "#42425d";
    ctx.font = `${Math.max(11, Math.min(14, width * 0.012))}px monospace`;
    ctx.fillText("play area", centerX, boxY + boxSize / 2 - 8);
    ctx.fillText("(screen is below)", centerX, boxY + boxSize / 2 + 10);

    const positions = cornerBoxPositions(layout);
    const markerRadius = Math.max(14, Math.min(22, boxSize * 0.075));

    CORNER_ORDER.forEach((cornerKey) => {
      const pos = positions[cornerKey];
      const captured = state.corners[cornerKey];
      const isActive = cornerKey === key;

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, markerRadius, 0, Math.PI * 2);
      let fill = "#313244";
      if (captured) fill = "#22c55e";
      else if (isActive) fill = "#f59e0b";
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = isActive ? "#f4f4f5" : "#585b70";
      ctx.lineWidth = isActive ? 3 : 1.5;
      ctx.stroke();

      ctx.fillStyle = captured || isActive ? "#13131c" : "#9298aa";
      ctx.font = `bold ${Math.max(11, markerRadius * 0.7)}px monospace`;
      ctx.textAlign = "center";
      ctx.fillText(cornerKey, pos.x, pos.y + markerRadius * 0.33);

      // Captured value sits outside the box, pushed away from the centre.
      const outX = pos.x < centerX ? pos.x - markerRadius - 10 : pos.x + markerRadius + 10;
      const outY = pos.y < boxY + boxSize / 2 ? pos.y - markerRadius - 8 : pos.y + markerRadius + 20;
      ctx.textAlign = pos.x < centerX ? "right" : "left";
      ctx.fillStyle = captured ? "#9298aa" : "#42425d";
      ctx.font = `${Math.max(11, Math.min(14, width * 0.012))}px monospace`;
      ctx.fillText(
        captured
          ? `${COLUMN_NAMES[captured.column]} @ ${captured.distanceCm.toFixed(1)}cm`
          : "not captured",
        outX,
        outY
      );
    });

    // Live reading + derived bounds
    ctx.textAlign = "center";
    const readoutY = layout.buttons[0].y - 52;
    ctx.font = `bold ${Math.max(14, Math.min(20, width * 0.017))}px monospace`;
    if (reading && reading.status === "ok") {
      ctx.fillStyle = "#22c55e";
      ctx.fillText(
        `live: ${COLUMN_NAMES[reading.column]} sensor @ ${reading.distanceCm.toFixed(1)}cm`,
        centerX,
        readoutY
      );
    } else {
      ctx.fillStyle = "#ef4444";
      let text = "live: no valid reading";
      if (reading && reading.status === "too-close") text = "live: too close to screen";
      else if (reading && reading.status === "out-of-bounds") text = "live: reading out of bounds";
      ctx.fillText(text, centerX, readoutY);
    }

    ctx.font = `${Math.max(11, Math.min(14, width * 0.012))}px monospace`;
    if (bounds.bad) {
      ctx.fillStyle = "#ef4444";
      ctx.fillText("Corners too close together - recapture with more depth", centerX, readoutY + 24);
    } else if (complete) {
      ctx.fillStyle = "#9298aa";
      const rowDepth = (bounds.farCm - bounds.nearCm) / 3;
      ctx.fillText(
        `rows: ${bounds.nearCm.toFixed(0)}cm to ${bounds.farCm.toFixed(0)}cm (${rowDepth.toFixed(0)}cm each)` +
          (bounds.flipped ? "  |  sensor order reversed" : ""),
        centerX,
        readoutY + 24
      );
    }

    // Action buttons
    const canCapture = Boolean(reading && reading.status === "ok") && !complete;
    layout.buttons.forEach((button) => {
      let enabled = true;
      if (button.type === "capture") enabled = canCapture;
      else if (button.type === "start") enabled = complete;

      let fill = "#475569";
      if (!enabled) fill = "#313244";
      else if (button.type === "start") fill = "#22c55e";
      else if (button.type === "capture") fill = "#89b4fa";

      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.roundRect(button.x, button.y, button.width, button.height, 8);
      ctx.fill();

      let labelColor = "#13131c";
      if (!enabled) labelColor = "#585b70";
      else if (button.type === "reset") labelColor = "#fff";

      ctx.fillStyle = labelColor;
      ctx.font = "bold 16px monospace";
      ctx.textAlign = "center";
      ctx.fillText(button.label, button.x + button.width / 2, button.y + button.height / 2 + 6);
    });

    ctx.textAlign = "start";
  };
})();
