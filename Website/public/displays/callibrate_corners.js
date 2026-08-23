// callibrate_corners.js - Play-area calibration + raw -> grid coordinate mapping.
//
// No triangulation. The three ultrasonic sensors sit on one line, all pointing
// straight forward, so each sensor owns one COLUMN of the 3x3 board:
//
//        left sensor      centre sensor     right sensor
//            |                  |                 |
//        column 0           column 1          column 2
//
// Whichever sensor sees the player decides the column; that sensor's distance
// reading decides the row. 3 columns x 3 distance bands = the 9 grid cells.
//
// Calibration walks SIX points - the near and far edge of every column - so
// each sensor gets its own bounds. Sensors are rarely mounted at exactly the
// same depth, and one shared bound smears that error across the whole board.
//
// Every point is measured by exactly ONE sensor: the left-hand points only by
// the left sensor, and so on. Reading a right-hand point off the centre sensor
// would measure a diagonal rather than that column's depth.
//
// The captured bounds also define the play area's limits, which is what the
// alert and out-of-bounds messages key off:
//
//     < alertCm          "too close to screen"   (safety, floored at 10cm)
//     alertCm .. maxCm   in play, mapped to rows 0-2
//     > maxCm            "come back in bounds"
//
// API on `window`:
//   window.renderCalibrateCorners(ctx, canvas, reading)
//   window.getCalibrateCornersButtonAtPoint(canvas, x, y)
//   window.captureCorner(reading)          - store the active point, advance
//   window.getCornerReading(reading, key)  - that point's owning-sensor value
//   window.resetCornerCalibration()
//   window.isCornerCalibrationComplete()
//   window.getCornerCalibration()
//   window.getCalibrationBounds()          - { nearCm, farCm, alertCm, maxCm, perColumn }
//   window.rawToGrid(column, distanceCm, previous) -> { gx, gy, inside, calibrated }

(function () {
  // Capture order walks the near edge left-to-right, then back along the far
  // edge, so the operator never crosses the play area mid-sequence.
  const POINTS = [
    { key: "BL", label: "Bottom-Left", column: 0, sensor: "LEFT", edge: "near" },
    { key: "BC", label: "Bottom-Centre", column: 1, sensor: "CENTRE", edge: "near" },
    { key: "BR", label: "Bottom-Right", column: 2, sensor: "RIGHT", edge: "near" },
    { key: "TR", label: "Top-Right", column: 2, sensor: "RIGHT", edge: "far" },
    { key: "TC", label: "Top-Centre", column: 1, sensor: "CENTRE", edge: "far" },
    { key: "TL", label: "Top-Left", column: 0, sensor: "LEFT", edge: "far" },
  ];

  const POINT_ORDER = POINTS.map((point) => point.key);
  const COLUMN_NAMES = ["Left", "Centre", "Right"];

  // Used when sensor mode starts without a completed calibration, so the game
  // still responds instead of going dead.
  const DEFAULT_NEAR_CM = 20;
  const DEFAULT_FAR_CM = 140;

  // Breathing room outside the calibrated edges. Standing a step past a corner
  // should report the edge row, not throw the player out of the game.
  const EDGE_MARGIN_CM = 15;

  // Absolute limits, whatever the calibration says. The alert can only ever
  // become MORE cautious than this floor, never less.
  const ABSOLUTE_ALERT_CM = 10;
  const ABSOLUTE_MAX_CM = 150;

  // How far past a row boundary a reading must travel before the row changes.
  const BAND_HYSTERESIS_CM = 6;

  // A column whose near and far edges are this close together is a mis-capture.
  const MIN_PLAY_DEPTH_CM = 15;

  const state = {
    points: POINT_ORDER.reduce((acc, key) => {
      acc[key] = null;
      return acc;
    }, {}),
    activeIndex: 0,
  };

  function pointFor(key) {
    return POINTS.find((point) => point.key === key) || null;
  }

  function activeKey() {
    return POINT_ORDER[state.activeIndex] || null;
  }

  function capturedCount() {
    return POINT_ORDER.filter((key) => state.points[key] !== null).length;
  }

  function isComplete() {
    return capturedCount() === POINT_ORDER.length;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function maxCaptureCm() {
    return (window.SENSOR_LIMITS && window.SENSOR_LIMITS.maxCm) || ABSOLUTE_MAX_CM;
  }

  // The conditioned reading from the one sensor this point is allowed to use.
  // Returns null when that sensor has nothing usable, regardless of what the
  // other two are reporting.
  function readingForPoint(reading, key) {
    const point = pointFor(key);
    if (!point || !reading || !Array.isArray(reading.filtered)) return null;

    const distance = reading.filtered[point.column];
    if (distance === null || distance === undefined) return null;
    if (!Number.isFinite(distance)) return null;
    if (distance < ABSOLUTE_ALERT_CM) return null;
    if (distance > maxCaptureCm()) return null;
    return distance;
  }

  window.getCornerReading = readingForPoint;

  function defaultBounds(extra) {
    return {
      nearCm: DEFAULT_NEAR_CM,
      farCm: DEFAULT_FAR_CM,
      alertCm: ABSOLUTE_ALERT_CM,
      maxCm: ABSOLUTE_MAX_CM,
      perColumn: [0, 1, 2].map(() => ({ near: DEFAULT_NEAR_CM, far: DEFAULT_FAR_CM })),
      calibrated: false,
      ...extra,
    };
  }

  // Derives the usable calibration. Each column keeps its own near/far; the
  // alert and out-of-bounds limits come from the extremes across all three, so
  // no column gets clipped by another column's geometry.
  function getBounds() {
    if (!isComplete()) return defaultBounds();

    const perColumn = [0, 1, 2].map((column) => {
      const near = POINTS.find((p) => p.column === column && p.edge === "near");
      const far = POINTS.find((p) => p.column === column && p.edge === "far");
      return {
        near: state.points[near.key].distanceCm,
        far: state.points[far.key].distanceCm,
      };
    });

    const shallow = perColumn.some((col) => !(col.far - col.near >= MIN_PLAY_DEPTH_CM));
    if (shallow) return defaultBounds({ bad: true });

    const nearCm = Math.min(...perColumn.map((col) => col.near));
    const farCm = Math.max(...perColumn.map((col) => col.far));

    return {
      nearCm,
      farCm,
      perColumn,
      // Step in front of the nearest calibrated edge and you are off the board
      // toward the screen. Never less cautious than the absolute floor.
      alertCm: Math.max(ABSOLUTE_ALERT_CM, nearCm - EDGE_MARGIN_CM),
      // Past the furthest calibrated edge you are off the back of the board.
      maxCm: Math.min(ABSOLUTE_MAX_CM, farCm + EDGE_MARGIN_CM),
      calibrated: true,
    };
  }

  window.getCalibrationBounds = getBounds;

  // Is this distance inside the given column's play area? Used to prefer a
  // sensor that can actually see the player over one staring at a wall.
  window.isWithinPlayArea = function isWithinPlayArea(column, distanceCm) {
    if (!Number.isInteger(column) || column < 0 || column > 2) return false;
    if (!Number.isFinite(distanceCm)) return false;
    const { near, far } = getBounds().perColumn[column];
    return distanceCm >= near - EDGE_MARGIN_CM && distanceCm <= far + EDGE_MARGIN_CM;
  };

  // Picks the row, refusing to leave the previous one until the reading has
  // travelled BAND_HYSTERESIS_CM clear of the boundary between them.
  function bandFor(distanceCm, nearCm, rowDepth, previousGy) {
    const candidate = clamp(Math.floor((distanceCm - nearCm) / rowDepth), 0, 2);
    if (previousGy === null || candidate === previousGy) return candidate;

    const boundary = nearCm + rowDepth * Math.max(candidate, previousGy);
    if (Math.abs(distanceCm - boundary) < BAND_HYSTERESIS_CM) return previousGy;
    return candidate;
  }

  // Raw fix -> play-area grid coordinate.
  //   column     - which sensor saw the player (0 left, 1 centre, 2 right)
  //   distanceCm - that sensor's distance reading
  //   previous   - the last grid result, used for row hysteresis (optional)
  window.rawToGrid = function rawToGrid(column, distanceCm, previous) {
    if (!Number.isInteger(column) || column < 0 || column > 2) return null;
    if (!Number.isFinite(distanceCm)) return null;

    const bounds = getBounds();
    const { near, far } = bounds.perColumn[column];

    // The slot index IS the column - calibrate.js already resolved which
    // physical sensor fills each slot.
    const gx = column;

    const rowDepth = (far - near) / 3;
    const previousGy = previous && previous.gx === gx ? previous.gy : null;
    const gy = bandFor(distanceCm, near, rowDepth, previousGy);

    const inside = distanceCm >= near - EDGE_MARGIN_CM && distanceCm <= far + EDGE_MARGIN_CM;

    return {
      gx,
      gy,
      inside,
      calibrated: bounds.calibrated,
      nearCm: near,
      farCm: far,
      rowDepth,
    };
  };

  window.isCornerCalibrationComplete = isComplete;

  window.getCornerCalibration = function getCornerCalibration() {
    return {
      points: { ...state.points },
      activeKey: activeKey(),
      captured: capturedCount(),
      total: POINT_ORDER.length,
      complete: isComplete(),
      ...getBounds(),
    };
  };

  window.resetCornerCalibration = function resetCornerCalibration() {
    POINT_ORDER.forEach((key) => {
      state.points[key] = null;
    });
    state.activeIndex = 0;
  };

  // Stores the current reading against the active point and advances. Returns
  // false when that point's own sensor has nothing usable.
  window.captureCorner = function captureCorner(reading) {
    const key = activeKey();
    if (!key) return false;

    // Deliberately ignores reading.column: that is whichever sensor happens to
    // be nearest, which is not necessarily the one that owns this point.
    const distance = readingForPoint(reading, key);
    if (distance === null) return false;

    state.points[key] = { column: pointFor(key).column, distanceCm: distance };

    const nextIndex = POINT_ORDER.findIndex((k) => state.points[k] === null);
    state.activeIndex = nextIndex === -1 ? POINT_ORDER.length : nextIndex;
    return true;
  };

  // --- Layout ---------------------------------------------------------------

  window.getCalibrateCornersLayout = function getCalibrateCornersLayout(canvas) {
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const centerX = width / 2;

    const boxW = Math.min(width * 0.5, 420);
    const boxH = Math.min(height * 0.28, 230);
    const boxX = centerX - boxW / 2;
    const boxY = Math.max(160, height * 0.26);

    const buttonWidth = Math.min(190, Math.max(130, width * 0.16));
    const buttonHeight = 48;
    const gap = 14;
    const row = [
      { type: "capture", label: "Capture" },
      { type: "reset", label: "Reset" },
      { type: "start", label: "Start Game" },
    ];
    const rowWidth = row.length * buttonWidth + (row.length - 1) * gap;
    const rowY = Math.min(height - buttonHeight - 24, boxY + boxH + 150);

    return {
      width,
      height,
      centerX,
      boxX,
      boxY,
      boxW,
      boxH,
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

  // Marker positions inside the preview box, in screen space (y grows down).
  // Near edge along the bottom, far edge along the top.
  function markerPositions(layout) {
    const { boxX, boxY, boxW, boxH } = layout;
    const cols = [boxX, boxX + boxW / 2, boxX + boxW];
    return {
      TL: { x: cols[0], y: boxY },
      TC: { x: cols[1], y: boxY },
      TR: { x: cols[2], y: boxY },
      BL: { x: cols[0], y: boxY + boxH },
      BC: { x: cols[1], y: boxY + boxH },
      BR: { x: cols[2], y: boxY + boxH },
    };
  }

  window.renderCalibrateCorners = function renderCalibrateCorners(ctx, canvas, reading) {
    const layout = window.getCalibrateCornersLayout(canvas);
    const { width, height, centerX, boxX, boxY, boxW, boxH } = layout;
    const key = activeKey();
    const complete = isComplete();
    const bounds = getBounds();
    const active = key ? pointFor(key) : null;

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
    const titleY = Math.max(46, height * 0.075);
    ctx.textAlign = "center";
    ctx.fillStyle = "#f4f4f5";
    ctx.font = `bold ${Math.max(18, Math.min(30, width * 0.028))}px monospace`;
    ctx.fillText("Play Area Calibration", centerX, titleY);

    ctx.font = `${Math.max(13, Math.min(18, width * 0.016))}px monospace`;
    ctx.fillStyle = complete ? "#22c55e" : "#f59e0b";
    ctx.fillText(
      complete ? "All six points captured - press Start Game" : `Stand at the ${active.label.toUpperCase()}`,
      centerX,
      titleY + 28
    );

    if (!complete) {
      ctx.fillStyle = "#89b4fa";
      ctx.font = `${Math.max(12, Math.min(16, width * 0.014))}px monospace`;
      ctx.fillText(`measured by the ${active.sensor} sensor only`, centerX, titleY + 50);
    }

    ctx.fillStyle = "#585b70";
    ctx.font = `${Math.max(11, Math.min(14, width * 0.012))}px monospace`;
    ctx.fillText(`${capturedCount()} / ${POINT_ORDER.length} captured`, centerX, titleY + 72);

    // Play-area preview
    ctx.strokeStyle = "#2b2f3d";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(boxX, boxY, boxW, boxH);
    ctx.setLineDash([]);

    // Column dividers, to make the three lanes explicit.
    ctx.strokeStyle = "#1f2937";
    ctx.lineWidth = 1;
    [boxX + boxW / 3, boxX + (boxW * 2) / 3].forEach((x) => {
      ctx.beginPath();
      ctx.moveTo(x, boxY);
      ctx.lineTo(x, boxY + boxH);
      ctx.stroke();
    });

    ctx.fillStyle = "#42425d";
    ctx.font = `${Math.max(10, Math.min(13, width * 0.011))}px monospace`;
    ctx.fillText("far edge", centerX, boxY - 22);
    ctx.fillText("near edge  (screen below)", centerX, boxY + boxH + 40);

    const positions = markerPositions(layout);
    const markerRadius = Math.max(13, Math.min(20, boxW * 0.045));

    POINT_ORDER.forEach((pointKey) => {
      const pos = positions[pointKey];
      const captured = state.points[pointKey];
      const isActive = pointKey === key;
      const owner = pointFor(pointKey);

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
      ctx.font = `bold ${Math.max(10, markerRadius * 0.62)}px monospace`;
      ctx.textAlign = "center";
      ctx.fillText(pointKey, pos.x, pos.y + markerRadius * 0.32);

      // Value sits outside the box: above the far edge, below the near one.
      const isFar = owner.edge === "far";
      const outY = isFar ? pos.y - markerRadius - 8 : pos.y + markerRadius + 18;
      ctx.fillStyle = captured ? "#9298aa" : "#42425d";
      ctx.font = `${Math.max(10, Math.min(12, width * 0.011))}px monospace`;
      ctx.fillText(captured ? `${captured.distanceCm.toFixed(0)}cm` : owner.sensor, pos.x, outY);
    });

    // Live reading from the owning sensor
    const readoutY = layout.buttons[0].y - 66;
    const liveDistance = key ? readingForPoint(reading, key) : null;
    ctx.textAlign = "center";
    ctx.font = `bold ${Math.max(14, Math.min(19, width * 0.016))}px monospace`;

    if (complete) {
      ctx.fillStyle = "#22c55e";
      ctx.fillText("ready", centerX, readoutY);
    } else if (liveDistance !== null) {
      ctx.fillStyle = "#22c55e";
      ctx.fillText(`${active.sensor} sensor: ${liveDistance.toFixed(1)}cm`, centerX, readoutY);
    } else {
      ctx.fillStyle = "#ef4444";
      ctx.fillText(`${active ? active.sensor : "target"} sensor: no usable reading`, centerX, readoutY);
    }

    // The other two, greyed out, so a mis-wired rig is obvious.
    if (!complete && Array.isArray(reading && reading.filtered)) {
      ctx.fillStyle = "#42425d";
      ctx.font = `${Math.max(10, Math.min(12, width * 0.011))}px monospace`;
      const others = reading.filtered
        .map((value, index) => {
          if (index === active.column) return null;
          const shown = value === null || value === undefined ? "--" : value.toFixed(0) + "cm";
          return `${COLUMN_NAMES[index]} ${shown}`;
        })
        .filter(Boolean)
        .join("   ");
      ctx.fillText(`ignored:  ${others}`, centerX, readoutY + 20);
    }

    // Derived limits, so the operator can see what this calibration enforces.
    ctx.font = `${Math.max(10, Math.min(13, width * 0.011))}px monospace`;
    if (bounds.bad) {
      ctx.fillStyle = "#ef4444";
      ctx.fillText("A column is too shallow - recapture with more depth", centerX, readoutY + 42);
    } else if (complete) {
      ctx.fillStyle = "#9298aa";
      const cols = bounds.perColumn
        .map((col, i) => `${COLUMN_NAMES[i]} ${col.near.toFixed(0)}-${col.far.toFixed(0)}`)
        .join("   ");
      ctx.fillText(cols, centerX, readoutY + 42);
      ctx.fillStyle = "#f59e0b";
      ctx.fillText(
        `alert below ${bounds.alertCm.toFixed(0)}cm   ·   out of bounds past ${bounds.maxCm.toFixed(0)}cm`,
        centerX,
        readoutY + 62
      );
    }

    // Action buttons
    const canCapture = !complete && liveDistance !== null;
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
