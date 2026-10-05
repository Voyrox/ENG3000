// callibrate_corners.js - Play-area bounds + raw -> grid coordinate mapping.
//
// There is no play-area calibration screen any more: calibration is the sensor
// assignment screen (calibrate.js), with both servos held at 90 degrees while
// the operator aims the nodes straight out. The game plays on the default
// bounds below (DEFAULT_NEAR_CM .. DEFAULT_FAR_CM in every column). The corner
// capture API is kept - the parity trace calibrates through it - so a capture
// step can come back without touching the mapping.
//
// No triangulation. The rig has two ultrasonic sensors now, LEFT and RIGHT, on
// one line and pointing straight forward; there is no centre sensor. Each owns
// an outer COLUMN of the 3x3 board:
//
//        left sensor                        right sensor
//            |                                   |
//        column 0           column 1          column 2
//                        (no sensor)
//
// Whichever sensor sees the player decides the column; that sensor's distance
// reading decides the row.
//
// Calibration walks FOUR points - the near and far edge of the left and right
// columns - so each sensor gets its own bounds. Sensors are rarely mounted at
// exactly the same depth, and one shared bound smears that error across the
// whole board. The centre column has no sensor to measure it: its bounds are
// the mean of its two neighbours, so the board still draws three even lanes.
//
// Every point is measured by exactly ONE sensor: the left-hand points only by
// the left sensor, the right-hand ones only by the right. Reading a right-hand
// point off the left sensor would measure a diagonal rather than that column's
// depth.
//
// The captured bounds also define the play area's limits, which is what the
// alert and out-of-bounds messages key off:
//
//     < alertCm          "too close to screen"   (safety, floored at 10cm)
//     alertCm .. maxCm   in play, mapped to rows 0-2
//     > maxCm            "come back in bounds"
//
// API on `window`:
//   window.captureCorner(reading)          - store the active point, advance
//   window.getCornerReading(reading, key)  - that point's owning-sensor value
//   window.resetCornerCalibration()
//   window.isCornerCalibrationComplete()
//   window.getCornerCalibration()
//   window.getCalibrationBounds()          - { nearCm, farCm, alertCm, maxCm, perColumn }
//   window.getCapturedCalibration()        - [{ near, far }] x3 (centre derived), or null
//   window.isPointInPlayArea(xCm, yCm)     - is that point on the board (with the margin)?
//   window.rawToGrid(column, distanceCm, previous) -> { gx, gy, inside, calibrated }

(function () {
  // Capture order walks the near edge left-to-right, then back along the far
  // edge, so the operator never crosses the play area mid-sequence.
  const POINTS = [
    { key: "BL", label: "Bottom-Left", column: 0, sensor: "LEFT", edge: "near" },
    { key: "BR", label: "Bottom-Right", column: 2, sensor: "RIGHT", edge: "near" },
    { key: "TR", label: "Top-Right", column: 2, sensor: "RIGHT", edge: "far" },
    { key: "TL", label: "Top-Left", column: 0, sensor: "LEFT", edge: "far" },
  ];

  const POINT_ORDER = POINTS.map((point) => point.key);
  // The columns with a sensor of their own; the centre (1) has none.
  const SENSOR_COLUMNS = [0, 2];
  const CENTRE_COLUMN = 1;

  // Used when sensor mode starts without a completed calibration, so the game
  // still responds instead of going dead. The rows start behind the dead zone,
  // the front ABSOLUTE_ALERT_CM of the grid, and end at its far edge
  // (GRID_LENGTH_CM in game.js): three rows of 50 cm, square with the columns
  // (Aaron, 5 Oct). filterRules.py PlayArea.per_column.
  const DEFAULT_NEAR_CM = 10;
  const DEFAULT_FAR_CM = 160;

  // Breathing room outside the calibrated edges. Standing a step past a corner
  // should report the edge row, not throw the player out of the game.
  const EDGE_MARGIN_CM = 15;

  // Absolute limits, whatever the calibration says. The alert can only ever
  // become MORE cautious than this floor, never less.
  const ABSOLUTE_ALERT_CM = 10;
  // The nodes' range plus the body radius: MAX_COORD_CM in game.js says why.
  const ABSOLUTE_MAX_CM = 205;

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
  // other one is reporting.
  //
  // A scanner node is usually turned towards the player, so its distance is a
  // slant, not the depth the rows are cut from: readSensorCoordinate() turns it
  // back by the servo angle into `depth`, and that is what gets captured. A
  // reading without depth (a straight-ahead sensor) is its own depth.
  function readingForPoint(reading, key) {
    const point = pointFor(key);
    if (!point || !reading || !Array.isArray(reading.filtered)) return null;

    const depths = Array.isArray(reading.depth) ? reading.depth : reading.filtered;
    const distance = depths[point.column];
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

  // The four captured points as { near, far } per column: the left and right
  // columns exactly as measured, the centre (no sensor) the mean of the two.
  // Null until all four are in. Unlike getBounds() there is no fallback to
  // defaults here: this is what gets sent to the server, whose PlayArea
  // applies the same shallow-column fallback itself.
  function capturedPerColumn() {
    if (!isComplete()) return null;

    const [left, right] = SENSOR_COLUMNS.map((column) => {
      const near = POINTS.find((p) => p.column === column && p.edge === "near");
      const far = POINTS.find((p) => p.column === column && p.edge === "far");
      return {
        near: state.points[near.key].distanceCm,
        far: state.points[far.key].distanceCm,
      };
    });

    const perColumn = [];
    perColumn[SENSOR_COLUMNS[0]] = left;
    perColumn[SENSOR_COLUMNS[1]] = right;
    perColumn[CENTRE_COLUMN] = { near: (left.near + right.near) / 2, far: (left.far + right.far) / 2 };
    return perColumn;
  }

  window.getCapturedCalibration = capturedPerColumn;

  // Derives the usable calibration. The alert and out-of-bounds limits come
  // from the extremes across the two measured columns, so no column gets
  // clipped by another column's geometry.
  function getBounds() {
    const perColumn = capturedPerColumn();
    if (!perColumn) return defaultBounds();

    const measured = SENSOR_COLUMNS.map((column) => perColumn[column]);
    const shallow = measured.some((col) => !(col.far - col.near >= MIN_PLAY_DEPTH_CM));
    if (shallow) return defaultBounds({ bad: true });

    const nearCm = Math.min(...measured.map((col) => col.near));
    const farCm = Math.max(...measured.map((col) => col.far));

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

  // Where each slot's node physically stands, left to right, in centimetres
  // across the play area: on the screen edge at the centre of the column it
  // owns, which is the same x the grid mapping uses, so a position and the
  // cell derived from it can never disagree about where the column boundaries
  // are. The rig has two nodes, LEFT and RIGHT (SENSOR_COLUMNS); the centre
  // column has none, so it has no x.
  const AREA_WIDTH_CM = 150; // matches PlayArea.width_cm in filterRules.py
  const COLUMN_COUNT = 3;

  window.getSensorCount = function getSensorCount() {
    return SENSOR_COLUMNS.length;
  };

  window.getSensorX = function getSensorX(column) {
    if (!SENSOR_COLUMNS.includes(column)) return null;
    return ((column + 0.5) * AREA_WIDTH_CM) / COLUMN_COUNT;
  };

  // Is the point (x across, y out from the screen, in cm) on the board, give
  // or take EDGE_MARGIN_CM on every side? The column x falls in sets the
  // depth span. A node's distance is along its servo line, so it is only a
  // depth when the node points straight out: across the board it is the long
  // side of the triangle, and held up against the rows' depth it would throw
  // the player out. Turn it into a point first (scannerPoint() in game.js).
  window.isPointInPlayArea = function isPointInPlayArea(xCm, yCm) {
    if (!Number.isFinite(xCm) || !Number.isFinite(yCm)) return false;
    if (xCm < -EDGE_MARGIN_CM || xCm > AREA_WIDTH_CM + EDGE_MARGIN_CM) return false;
    const column = clamp(Math.floor(xCm / (AREA_WIDTH_CM / COLUMN_COUNT)), 0, COLUMN_COUNT - 1);
    return window.isWithinPlayArea(column, yCm);
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
  //   column     - which sensor saw the player (0 left, 2 right; 1 has no sensor)
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

})();
