// game.js - Whack-a-mole game state, logic, and rendering.
//
// This module owns the game's internal state and exposes a small API on
// `window` that canvas.js drives:

//   window.resetGame()                         - start/restart a round
//   window.setGameInputMode(mode)               - "mouse" | "sensor"
//   window.getGameInputMode()
//   window.pauseGame() / window.resumeGame()    - pause/resume mid-round
//   window.updateGame(timestampMs, canvas, orderedNodes) - advance, call every frame
//   window.setGameCursor(canvas, x, y)          - mouse-mode coordinate input
//   window.readSensorCoordinate(orderedNodes)   - raw fix, also used by calibration
//   window.isGameAlertActive()                  - drive the full-screen alert
//   window.getGameAlertInfo()                   - { active, distanceCm }
//   window.handleGameClick(canvas, x, y)        - register a hit attempt
//   window.getGamePauseButtonAtPoint(canvas,x,y)- hit-test the pause icon
//   window.getPauseMenuButtonAtPoint(canvas,x,y)- hit-test Resume / Restart / Main Menu
//   window.getGameOverButtonAtPoint(canvas,x,y) - hit-test Restart / Return to Start
//   window.renderGame(ctx, canvas)              - draw the current frame
//   window.getGameState()                       - read-only peek at state (score/level/etc)
//
// Two input modes share all of the game logic. Only the cursor source differs:
//   "mouse"  - canvas.js feeds raw canvas pixels straight from mousemove.
//              Reached via Skip on the calibration screen.
//   "sensor" - readSensorCoordinate() picks the sensor that sees the player,
//              rawToGrid() (callibrate_corners.js) turns that into 0-2 grid
//              coordinates with (0,0) at BOTTOM-LEFT, and gridToCanvasPoint()
//              places the cursor. Entered once all three nodes are configured.

(function () {
  const GAME_DURATION_MS = 60000; // overall round length shown as the countdown
  const HITS_PER_LEVEL = 5; // score needed to advance a level
  const MAX_LEVEL = 10; // difficulty stops ramping here, so "last level" is a real thing
  const BASE_MOLE_MS = 12000; // visible duration at level 1
  const FINAL_MOLE_MS = 4000; // visible duration at MAX_LEVEL
  const TEST_MODE_MOLE_MS = 10000; // fixed, generous window while testing the rig
  const MIN_SPAWN_DELAY_MS = 500; // gap before a new mole appears
  const MAX_SPAWN_DELAY_MS = 700;
  const HIT_FEEDBACK_MS = 200; // how long the "hit" flash lasts
  const SUPER_MOLE_POINTS = 3; // score awarded for hitting a super mole
  const BOMB_PENALTY = 3; // score lost for hitting a bomb
  const BOMB_SPAWN_CHANCE = 0.2; // share of spawns that are bombs
  const SUPER_SPAWN_CHANCE = 0.15; // share of spawns that are super moles
  const DEFAULT_LIVES = 5;
  const DURATION_OPTIONS_MS = [30000, 60000, 90000];
  const LIVES_OPTIONS = [1, 3, 5, 7, 9];

  // --- Sensor input ----------------------------------------------------------
  // No triangulation: the three sensors sit on one line pointing straight
  // forward, so each owns one column of the board and its distance reading
  // picks the row. See callibrate_corners.js for the grid mapping.
  const MAX_COORD_CM = 150; // a reading beyond 1.5 m is bogus -> "come back in bounds"

  // Reading conditioning. The firmware ships RAW distances - the 3-sample
  // average in ultrasonicSensor.cpp is commented out - so spikes and dropped
  // echoes arrive here unsmoothed. Without the filtering below, one bad frame
  // out of the 20/sec each node sends was enough to pause the round.
  const SENSOR_HISTORY = 5;       // samples per sensor in the median window
  const SENSOR_HOLD_MS = 350;     // coast a sensor through a dropped echo
  // How many consecutive unusable READINGS to ride out before admitting defeat
  // and showing the come-closer / out-of-bounds screen. Counted in sensor
  // readings rather than render frames: the game draws at ~60fps while each
  // node reports at 20Hz, so a frame budget would expire three times too fast.
  const MAX_HELD_READINGS = 10;
  // Backstop for when data stops arriving altogether, so a disconnected rig
  // cannot leave a stale cursor on screen forever.
  const HOLD_TIMEOUT_MS = 2500;
  const COLUMN_MARGIN_CM = 8;     // a rival sensor must beat this to steal the column
  const TOO_CLOSE_FRAMES = 2;     // consecutive raw frames needed to raise the alert


  // Adjustable via the Options screen; read fresh at the start of each round.
  const settings = {
    durationMs: GAME_DURATION_MS,
    startingLives: DEFAULT_LIVES,
    soundEnabled: true,
    // Test mode: no bombs spawn and lives are never lost, so a run can be used
    // to exercise the sensor pipeline without the round ending underneath you.
    testMode: false,
  };

  window.getGameSettings = function getGameSettings() {
    return { ...settings };
  };

  window.setGameSettings = function setGameSettings(partial) {
    Object.assign(settings, partial);
  };

  // Console shortcut: testMode() toggles, testMode(true/false) sets.
  window.testMode = function testMode(enabled) {
    settings.testMode = typeof enabled === "boolean" ? enabled : !settings.testMode;
    console.info(
      `[test] test mode ${
        settings.testMode ? "ON - no bombs, infinite lives, no timer, 10s moles" : "OFF"
      }`
    );
    return settings.testMode;
  };

  window.DURATION_OPTIONS_MS = DURATION_OPTIONS_MS;
  window.LIVES_OPTIONS = LIVES_OPTIONS;

  const moleImages = {};
  ["hole", "mole", "bomb", "dead_mole", "super_mole", "super_mole_hit", "dead_super_mole"].forEach((name) => {
    const img = new Image();
    img.src = `/static/mole/${name}.png`;
    moleImages[name] = img;
  });

  function drawImageCentered(ctx, img, cx, cy, height) {
    const aspect = img.width / img.height;
    const w = height * aspect;
    ctx.drawImage(img, cx - w / 2, cy - height / 2, w, height);
  }

  function isImageReady(img) {
    return img && img.complete && img.naturalWidth > 0;
  }

  const emptySensorState = () => ({
    status: "no-signal", // "ok" | "too-close" | "no-signal" | "out-of-bounds"
    column: null, // which sensor saw the player: 0 left, 1 centre, 2 right
    distanceCm: null, // that sensor's raw reading
    gx: null,
    gy: null, // parsed 0-2 grid coordinate
    configured: 0, // how many sensors reported a usable number
  });

  const gameState = {
    status: "idle", // "idle" | "playing" | "paused" | "gameover"
    inputMode: "mouse", // "mouse" | "sensor"
    sensor: emptySensorState(),
    score: 0,
    level: 1,
    peakLevel: 1,
    lives: DEFAULT_LIVES,
    remainingMs: GAME_DURATION_MS,
    lastTickTime: null,
    activeHole: -1, // -1 means no mole currently up
    moleType: "mole", // "mole" | "bomb" | "super"
    moleWounded: false, // true once a hat (super) mole has taken its first of two hits
    moleSpawnedAt: 0,
    moleDurationMs: BASE_MOLE_MS,
    nextSpawnAt: 0,
    pausedAt: 0,
    hitFlash: { hole: -1, until: 0, type: null },
    cursor: { x: null, y: null, inBounds: true },
  };

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  // Capped, so the displayed level always matches the difficulty actually
  // in effect rather than climbing past the point where anything changes.
  function computeLevel(score) {
    return Math.min(MAX_LEVEL, 1 + Math.floor(score / HITS_PER_LEVEL));
  }

  // Straight linear ramp between the two named endpoints. A power curve would
  // dump most of the difficulty into the first few levels; sensor input needs
  // the player to physically walk to a cell, so an even step is fairer.
  function rampedMoleDuration(level) {
    const clamped = Math.max(1, Math.min(MAX_LEVEL, level));
    const progress = (clamped - 1) / (MAX_LEVEL - 1);
    return Math.round(BASE_MOLE_MS + (FINAL_MOLE_MS - BASE_MOLE_MS) * progress);
  }

  function computeMoleDuration(level) {
    // Test mode pins every mole to one generous window, so the difficulty ramp
    // cannot shift underneath you while the sensor rig is being exercised.
    if (settings.testMode) return TEST_MODE_MOLE_MS;
    return rampedMoleDuration(level);
  }

  // Always reports the real difficulty curve, regardless of the current mode.
  window.getMoleDurationTable = function getMoleDurationTable() {
    return Array.from({ length: MAX_LEVEL }, (_, i) => ({
      level: i + 1,
      seconds: rampedMoleDuration(i + 1) / 1000,
      hitsToReach: i * HITS_PER_LEVEL,
    }));
  };

  // Extra lives to compensate for higher levels' shorter mole windows: +1 life every 2 levels.
  function levelLivesBonus(level) {
    return Math.floor((level - 1) / 2);
  }

  // Grants bonus lives as the player reaches new peak levels. Tracked against a
  // peak (rather than the current, occasionally-dipping level) so a bomb penalty
  // dropping the score - and with it the current level - never claws lives back.
  function grantLevelBonus(currentLevel) {
    if (currentLevel > gameState.peakLevel) {
      gameState.lives += levelLivesBonus(currentLevel) - levelLivesBonus(gameState.peakLevel);
      gameState.peakLevel = currentLevel;
    }
  }

  function pickRandomHole(excludeHole) {
    let hole;
    do {
      hole = Math.floor(Math.random() * 9);
    } while (hole === excludeHole);
    return hole;
  }

  function pickRandomMoleType() {
    const roll = Math.random();
    // Test mode drops bombs from the pool entirely; their share is folded into
    // ordinary moles so super moles keep their usual frequency.
    if (!settings.testMode && roll < BOMB_SPAWN_CHANCE) return "bomb";
    if (roll < BOMB_SPAWN_CHANCE + SUPER_SPAWN_CHANCE) return "super";
    return "mole";
  }

  // Single place that decides whether a life can actually be taken.
  function loseLife() {
    if (settings.testMode) return;
    gameState.lives = Math.max(0, gameState.lives - 1);
  }

  function isOutOfLives() {
    return !settings.testMode && gameState.lives <= 0;
  }

  function pointInRect(x, y, r) {
    return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
  }

  function getGameOverLayout(canvas) {
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const centerX = width / 2;
    const buttonWidth = 200;
    const buttonHeight = 52;

    return {
      restartButton: { x: centerX - buttonWidth - 10, y: height / 2 + 70, width: buttonWidth, height: buttonHeight },
      returnButton: { x: centerX + 10, y: height / 2 + 70, width: buttonWidth, height: buttonHeight },
    };
  }

  window.resetGame = function resetGame() {
    gameState.status = "playing";
    gameState.score = 0;
    // Always starts at level 1; players climb further levels by scoring, not by picking a start.
    gameState.level = 1;
    gameState.peakLevel = 1;
    gameState.lives = settings.startingLives;
    gameState.remainingMs = settings.durationMs;
    gameState.lastTickTime = null;
    gameState.activeHole = -1;
    gameState.moleType = "mole";
    gameState.moleWounded = false;
    gameState.moleSpawnedAt = 0;
    gameState.moleDurationMs = computeMoleDuration(gameState.level);
    gameState.nextSpawnAt = 0;
    gameState.hitFlash = { hole: -1, until: 0, type: null };
    gameState.cursor = { x: null, y: null, inBounds: true };
    gameState.sensor = emptySensorState();
    resetSensorFilters();
  };

  window.getGameState = function getGameState() {
    return gameState;
  };

  window.setGameInputMode = function setGameInputMode(mode) {
    gameState.inputMode = mode === "sensor" ? "sensor" : "mouse";
    // Drop any stale cursor so the two modes never inherit each other's position.
    gameState.cursor = { x: null, y: null, inBounds: true };
    gameState.sensor = emptySensorState();
    resetSensorFilters();
  };

  window.getGameInputMode = function getGameInputMode() {
    return gameState.inputMode;
  };

  // The full-screen alert is driven purely by the raw distance, and only in
  // sensor mode mid-round - the mouse has no notion of standing too close, and
  // a paused or finished round should not be hijacked.
  window.isGameAlertActive = function isGameAlertActive() {
    return (
      gameState.inputMode === "sensor" &&
      gameState.status === "playing" &&
      gameState.sensor.status === "too-close"
    );
  };

  window.getGameAlertInfo = function getGameAlertInfo() {
    return {
      active: window.isGameAlertActive(),
      distanceCm: gameState.sensor.status === "too-close" ? gameState.sensor.distanceCm : null,
    };
  };

  window.pauseGame = function pauseGame() {
    if (gameState.status !== "playing") return;
    gameState.status = "paused";
    gameState.pausedAt = performance.now();
  };

  // Shifts the mole/spawn timers forward by however long the pause lasted, so
  // the resumed round picks up exactly where it left off instead of the
  // paused wall-clock time counting against the mole timer / round clock.
  window.resumeGame = function resumeGame() {
    if (gameState.status !== "paused") return;
    const pausedDuration = performance.now() - gameState.pausedAt;
    gameState.moleSpawnedAt += pausedDuration;
    gameState.nextSpawnAt += pausedDuration;
    gameState.lastTickTime = null;
    gameState.status = "playing";
  };

  // Call every animation frame with a timestamp (e.g. from requestAnimationFrame).
  // `canvas` and `orderedNodes` are only needed in sensor mode; orderedNodes is
  // [left, centre, right] in calibration slot order.
  window.updateGame = function updateGame(now, canvas, orderedNodes) {
    if (gameState.inputMode === "sensor" && canvas) {
      updateSensorCursor(canvas, orderedNodes);
    }

    if (gameState.status !== "playing") return;

    if (gameState.lastTickTime === null) {
      gameState.lastTickTime = now;
      gameState.nextSpawnAt = now + randomBetween(MIN_SPAWN_DELAY_MS, MAX_SPAWN_DELAY_MS);
    }

    const elapsed = now - gameState.lastTickTime;
    gameState.lastTickTime = now;

    // Hold the round while the player is too close, out of bounds, or invisible
    // to the sensors. Advancing lastTickTime above keeps the clock from jumping
    // when play resumes; shifting the mole timers keeps the current mole alive.
    if (isSensorBlocked()) {
      gameState.moleSpawnedAt += elapsed;
      gameState.nextSpawnAt += elapsed;
      return;
    }

    // Test mode freezes the round clock, so a run lasts until you stop it.
    if (!settings.testMode) {
      gameState.remainingMs -= elapsed;

      if (gameState.remainingMs <= 0) {
        gameState.remainingMs = 0;
        gameState.status = "gameover";
        gameState.activeHole = -1;
        return;
      }
    }

    // Mole timed out without being hit -> remove it and schedule the next one.
    if (gameState.activeHole !== -1 && now - gameState.moleSpawnedAt >= gameState.moleDurationMs) {
      const missedMole = gameState.moleType !== "bomb"; // letting a bomb expire is fine, missing a mole costs a life
      gameState.activeHole = -1;
      gameState.moleWounded = false;
      gameState.nextSpawnAt = now + randomBetween(MIN_SPAWN_DELAY_MS, MAX_SPAWN_DELAY_MS);

      if (missedMole) {
        loseLife();
        if (isOutOfLives()) {
          gameState.status = "gameover";
          return;
        }
      }
    }

    gameState.level = computeLevel(gameState.score);
    gameState.moleDurationMs = computeMoleDuration(gameState.level);
    grantLevelBonus(gameState.level);

    // Spawn a mole if none is up and it's time (only one hole active at once).
    if (gameState.activeHole === -1 && now >= gameState.nextSpawnAt) {
      gameState.activeHole = pickRandomHole(-1);
      gameState.moleSpawnedAt = now;
      gameState.moleType = pickRandomMoleType();
      gameState.moleWounded = false;
    }
  };

  // Mouse-mode coordinate input. Ignored in sensor mode so a stray mouse
  // movement cannot fight the sensors for control of the cursor.
  window.setGameCursor = function setGameCursor(canvas, x, y) {
    if (gameState.inputMode !== "mouse") return;
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    gameState.cursor.x = x;
    gameState.cursor.y = y;
    gameState.cursor.inBounds = x >= 0 && x <= width && y >= 0 && y <= height;
  };

  window.getGameGridLayout = function getGameGridLayout(canvas) {
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const gridSize = Math.min(width * 0.7, height * 0.6, 480);
    const cellGap = 14;
    const cellSize = (gridSize - cellGap * 2) / 3;
    const gridLeft = width / 2 - gridSize / 2;
    const gridTop = height / 2 - gridSize / 2 + 20;

    const holes = [];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        holes.push({
          index: row * 3 + col,
          x: gridLeft + col * (cellSize + cellGap),
          y: gridTop + row * (cellSize + cellGap),
          size: cellSize,
        });
      }
    }

    return { holes, cellSize, gridLeft, gridTop, gridSize };
  };

  function awardPointForHole(holeIndex) {
    if (gameState.status !== "playing") return false;
    if (holeIndex !== gameState.activeHole) return false;

    const now = performance.now();
    const hitType = gameState.moleType;

    // Hat (super) moles take two hits to defeat. The first hit just wounds it and
    // refreshes its timer for the finishing blow - no score/life change yet.
    if (hitType === "super" && !gameState.moleWounded) {
      gameState.moleWounded = true;
      gameState.moleSpawnedAt = now;
      gameState.hitFlash = { hole: holeIndex, until: now + HIT_FEEDBACK_MS, type: "wounded" };
      return true;
    }

    if (hitType === "bomb") {
      gameState.score = Math.max(0, gameState.score - BOMB_PENALTY);
      loseLife();
    } else {
      gameState.score += hitType === "super" ? SUPER_MOLE_POINTS : 1;
    }

    gameState.hitFlash = { hole: holeIndex, until: now + HIT_FEEDBACK_MS, type: hitType };
    gameState.activeHole = -1;
    gameState.moleWounded = false;
    gameState.level = computeLevel(gameState.score);
    gameState.moleDurationMs = computeMoleDuration(gameState.level);
    grantLevelBonus(gameState.level);
    gameState.nextSpawnAt = now + randomBetween(MIN_SPAWN_DELAY_MS, MAX_SPAWN_DELAY_MS);

    if (isOutOfLives()) {
      gameState.status = "gameover";
    }
    return true;
  }

  // Registers a click/tap attempt at canvas-space coordinates (x, y).
  // Returns true only if it actually hit the currently active mole.
  window.handleGameClick = function handleGameClick(canvas, x, y) {
    if (gameState.status !== "playing") return false;

    const layout = window.getGameGridLayout(canvas);
    const hole = layout.holes.find(
      (h) => x >= h.x && x <= h.x + h.size && y >= h.y && y <= h.y + h.size
    );

    if (!hole) return false; // missed the grid entirely - no score change
    return awardPointForHole(hole.index);
  };

  window.handleGameHover = function handleGameHover(canvas, x, y) {
    if (gameState.status !== "playing") return false;

    const layout = window.getGameGridLayout(canvas);
    const hole = layout.holes.find(
      (h) => x >= h.x && x <= h.x + h.size && y >= h.y && y <= h.y + h.size
    );

    if (!hole) return false;
    return awardPointForHole(hole.index);
  };

  // --- Sensor input ----------------------------------------------------------

  // Pulls the distance out of a node's latest payload. Returns null when the
  // node is missing, offline, unparseable, or reported no echo (-1).
  function readDistance(node) {
    if (!node || !node.online || !node.latest) return null;

    let payload;
    try {
      payload = JSON.parse(node.latest);
    } catch (err) {
      return null;
    }

    const value = Number(payload.avg);
    if (!Number.isFinite(value) || value < 0) return null;
    return value;
  }

  // --- Per-sensor conditioning ----------------------------------------------

  function makeFilter() {
    return { samples: [], value: null, lastGoodAt: -Infinity };
  }

  const sensorFilters = [makeFilter(), makeFilter(), makeFilter()];

  // canvas.js bumps this on every nodes:update, so the pipeline can tell a
  // genuinely new reading from the same one being polled again by the render
  // loop. Comparing raw values would not work: a sustained dropout reports
  // [null, null, null] on every frame, which looks identical to no new data.
  let sensorFrameSeq = 0;
  let lastSeenFrameSeq = -1;
  let badReadingStreak = 0;

  window.markSensorFrame = function markSensorFrame() {
    sensorFrameSeq += 1;
  };

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  // A median rejects single-sample spikes far better than a mean, and the hold
  // window coasts through a dropped echo instead of reporting the player gone.
  function conditionSensor(filter, raw, now) {
    if (raw !== null) {
      filter.samples.push(raw);
      if (filter.samples.length > SENSOR_HISTORY) filter.samples.shift();
      filter.value = median(filter.samples);
      filter.lastGoodAt = now;
      return filter.value;
    }

    if (now - filter.lastGoodAt <= SENSOR_HOLD_MS) return filter.value;

    filter.samples.length = 0;
    filter.value = null;
    return null;
  }

  function resetSensorFilters() {
    sensorFilters.forEach((filter) => {
      filter.samples.length = 0;
      filter.value = null;
      filter.lastGoodAt = -Infinity;
    });
    closeStreak = 0;
    lastColumn = null;
    lastSeenFrameSeq = sensorFrameSeq;
    badReadingStreak = 0;
    sensorHold.grid = null;
    sensorHold.lastOkAt = -Infinity;
  }

  window.resetSensorFilters = resetSensorFilters;

  // --- Coordinate derivation -------------------------------------------------

  let lastColumn = null;
  let closeStreak = 0;

  // Input:  [left, centre, right] node records, nulls allowed (calibration order)
  // Output: {
  //   status:     "ok" | "too-close" | "no-signal" | "out-of-bounds",
  //   column:     which sensor saw the player - 0 left, 1 centre, 2 right,
  //   distanceCm: that sensor's conditioned reading,
  //   raw:        [l, c, r] straight off the wire, for debugging,
  //   filtered:   [l, c, r] after median + hold,
  //   configured: how many sensors currently have a usable value
  // }
  function readSensorCoordinate(orderedNodes) {
    const list = Array.isArray(orderedNodes) ? orderedNodes : [];
    const now = performance.now();

    const raw = [readDistance(list[0]), readDistance(list[1]), readDistance(list[2])];
    const filtered = raw.map((value, index) => conditionSensor(sensorFilters[index], value, now));
    const configured = filtered.filter((d) => d !== null).length;

    // Fresh data, or the same reading being polled again by the render loop?
    const isNewReading = sensorFrameSeq !== lastSeenFrameSeq;
    lastSeenFrameSeq = sensorFrameSeq;

    const base = { raw, filtered, configured, isNewReading, column: null, distanceCm: null };

    // Safety runs on the RAW readings, never the filtered ones: a median window
    // full of safe distances would smooth away the very spike the alert exists
    // to catch. Two consecutive frames (100 ms at 20 Hz) are required so that
    // crosstalk between the three sensors cannot raise a false alarm.
    const rawMin = raw.reduce(
      (min, value) => (value === null ? min : min === null || value < min ? value : min),
      null
    );
    if (rawMin !== null && window.isTooClose(rawMin)) {
      closeStreak += 1;
    } else {
      closeStreak = 0;
    }
    const tooClose = closeStreak >= TOO_CLOSE_FRAMES;

    // The player stands in front of one column at a time, so the nearest
    // reading identifies which. Anything further away is a wall or a side lobe.
    let column = null;
    let best = null;
    filtered.forEach((distance, index) => {
      if (distance === null) return;
      if (best === null || distance < best) {
        best = distance;
        column = index;
      }
    });

    // Safety outranks every other state, including loss of signal.
    if (tooClose) {
      return { ...base, column, distanceCm: rawMin, status: "too-close" };
    }

    if (best === null) {
      lastColumn = null;
      return { ...base, status: "no-signal" };
    }

    // Column hysteresis: a rival sensor must be clearly nearer before it steals
    // the column, otherwise noise flicks the cursor between adjacent columns.
    if (lastColumn !== null && column !== lastColumn && filtered[lastColumn] !== null) {
      if (best > filtered[lastColumn] - COLUMN_MARGIN_CM) {
        column = lastColumn;
        best = filtered[lastColumn];
      }
    }

    if (best > MAX_COORD_CM) {
      return { ...base, column, distanceCm: best, status: "out-of-bounds" };
    }

    lastColumn = column;
    return { ...base, column, distanceCm: best, status: "ok" };
  }

  window.readSensorCoordinate = readSensorCoordinate;

  // Shared with calibrate.js, which needs per-node distances to work out which
  // physical sensor the operator is holding a hand in front of.
  window.readNodeDistance = readDistance;

  // Grid coordinate (0-2, origin bottom-left) -> canvas pixels at the centre of
  // the matching hole.
  window.gridToCanvasPoint = function gridToCanvasPoint(canvas, gx, gy) {
    const layout = window.getGameGridLayout(canvas);
    const span = layout.gridSize - layout.cellSize;
    return {
      x: layout.gridLeft + (gx / 2) * span + layout.cellSize / 2,
      // Grid y grows upward (0 = nearest the screen), canvas y grows downward.
      y: layout.gridTop + ((2 - gy) / 2) * span + layout.cellSize / 2,
    };
  };

  // Last known-good cell, used to coast through brief signal loss.
  const sensorHold = { grid: null, lastOkAt: -Infinity };

  // Reads the sensors, maps the fix into grid space, and drives the cursor from
  // it. Hovering the active mole scores, exactly as the mouse does.
  function updateSensorCursor(canvas, orderedNodes) {
    const now = performance.now();
    const fix = readSensorCoordinate(orderedNodes);

    let grid = null;
    if (fix.status === "ok") {
      const mapped = window.rawToGrid(fix.column, fix.distanceCm, sensorHold.grid);
      if (mapped && mapped.inside) grid = mapped;
    }

    if (grid) {
      badReadingStreak = 0;
      sensorHold.grid = grid;
      sensorHold.lastOkAt = now;
      const point = window.gridToCanvasPoint(canvas, grid.gx, grid.gy);
      gameState.sensor = {
        ...fix, gx: grid.gx, gy: grid.gy,
        calibrated: grid.calibrated, held: false, heldFor: 0,
      };
      gameState.cursor = { x: point.x, y: point.y, inBounds: true };
      window.handleGameHover(canvas, point.x, point.y);
      return;
    }

    // Too close is a safety state: report it instantly, with no grace at all.
    if (fix.status === "too-close") {
      badReadingStreak = 0;
      sensorHold.grid = null;
      gameState.sensor = { ...fix, gx: null, gy: null, held: false, heldFor: 0 };
      gameState.cursor = { x: null, y: null, inBounds: false };
      return;
    }

    // Only genuinely new data counts against the budget - the render loop polls
    // far faster than the sensors report.
    if (fix.isNewReading) badReadingStreak += 1;

    // Ride out a short burst of bad readings on the last known-good cell. A
    // handful of rejects in a row is normal for unfiltered ultrasonics and must
    // not throw the player out of the game.
    const withinBudget = badReadingStreak <= MAX_HELD_READINGS;
    const withinTimeout = now - sensorHold.lastOkAt <= HOLD_TIMEOUT_MS;

    if (sensorHold.grid && withinBudget && withinTimeout) {
      const held = sensorHold.grid;
      const point = window.gridToCanvasPoint(canvas, held.gx, held.gy);
      gameState.sensor = {
        ...fix, status: "ok", gx: held.gx, gy: held.gy,
        calibrated: held.calibrated, held: true, heldFor: badReadingStreak,
      };
      gameState.cursor = { x: point.x, y: point.y, inBounds: true };
      window.handleGameHover(canvas, point.x, point.y);
      return;
    }

    sensorHold.grid = null;
    gameState.sensor = {
      ...fix,
      status: fix.status === "ok" ? "out-of-bounds" : fix.status,
      gx: null, gy: null, held: false, heldFor: badReadingStreak,
    };
    gameState.cursor = { x: null, y: null, inBounds: false };
  }

  // Everything the sensor pipeline currently knows. Callable from the browser
  // console as getSensorDebug() while a round is running.
  window.getSensorDebug = function getSensorDebug() {
    const sensor = gameState.sensor;
    return {
      status: sensor.status,
      held: Boolean(sensor.held),
      raw: sensor.raw || [null, null, null],
      filtered: sensor.filtered || [null, null, null],
      column: sensor.column,
      distanceCm: sensor.distanceCm,
      grid: sensor.gx === null ? null : { gx: sensor.gx, gy: sensor.gy },
      badReadings: badReadingStreak,
      holdBudget: MAX_HELD_READINGS,
      bounds: window.getCalibrationBounds ? window.getCalibrationBounds() : null,
      limits: { alertCm: window.ALERT_DISTANCE_CM, maxCm: MAX_COORD_CM },
    };
  };

  // True while sensor input cannot produce a playable coordinate. The round
  // clock is held during these states so the player is not penalised for a
  // dropout they cannot control.
  function isSensorBlocked() {
    return gameState.inputMode === "sensor" && gameState.sensor.status !== "ok";
  }

  window.getGameOverButtonAtPoint = function getGameOverButtonAtPoint(canvas, x, y) {
    if (gameState.status !== "gameover") return null;
    const layout = getGameOverLayout(canvas);

    if (pointInRect(x, y, layout.restartButton)) return { type: "restart" };
    if (pointInRect(x, y, layout.returnButton)) return { type: "return" };
    return null;
  };

  // Small square icon, top-left, above the score panel.
  function getGamePauseLayout() {
    return { x: 12, y: 12, width: 44, height: 44 };
  }

  window.getGamePauseButtonAtPoint = function getGamePauseButtonAtPoint(canvas, x, y) {
    if (gameState.status !== "playing") return null;
    return pointInRect(x, y, getGamePauseLayout()) ? { type: "pause" } : null;
  };

  function getPauseMenuLayout(canvas) {
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const centerX = width / 2;
    const buttonWidth = 220;
    const buttonHeight = 52;
    const gap = 16;
    const firstY = height / 2 - 80;

    return {
      resumeButton: { x: centerX - buttonWidth / 2, y: firstY, width: buttonWidth, height: buttonHeight },
      restartButton: { x: centerX - buttonWidth / 2, y: firstY + (buttonHeight + gap), width: buttonWidth, height: buttonHeight },
      menuButton: { x: centerX - buttonWidth / 2, y: firstY + (buttonHeight + gap) * 2, width: buttonWidth, height: buttonHeight },
    };
  }

  window.getPauseMenuButtonAtPoint = function getPauseMenuButtonAtPoint(canvas, x, y) {
    if (gameState.status !== "paused") return null;
    const layout = getPauseMenuLayout(canvas);

    if (pointInRect(x, y, layout.resumeButton)) return { type: "resume" };
    if (pointInRect(x, y, layout.restartButton)) return { type: "restart" };
    if (pointInRect(x, y, layout.menuButton)) return { type: "menu" };
    return null;
  };

  function renderGameOverOverlay(ctx, canvas) {
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const centerX = width / 2;
    const layout = getGameOverLayout(canvas);

    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, 0, width, height);

    const cardWidth = Math.min(480, width - 40);
    const cardTop = height / 2 - 130;
    const cardBottom = layout.restartButton.y + layout.restartButton.height + 26;
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
    ctx.shadowBlur = 30;
    ctx.fillStyle = "#1a1b26";
    ctx.beginPath();
    ctx.roundRect(centerX - cardWidth / 2, cardTop, cardWidth, cardBottom - cardTop, 18);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(centerX - cardWidth / 2, cardTop, cardWidth, cardBottom - cardTop, 18);
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.fillStyle = "#f4f4f5";
    ctx.font = "bold 40px monospace";
    ctx.fillText("Game Over", centerX, height / 2 - 60);

    ctx.fillStyle = "#9298aa";
    ctx.font = "18px monospace";
    ctx.fillText(`Score: ${gameState.score}   Level reached: ${gameState.level}`, centerX, height / 2 - 20);
    if (isOutOfLives()) {
      ctx.fillStyle = "#ef4444";
      ctx.fillText("Out of lives", centerX, height / 2 + 8);
    }

    ctx.save();
    ctx.shadowColor = "rgba(34, 197, 94, 0.4)";
    ctx.shadowBlur = 10;
    ctx.fillStyle = "#22c55e";
    ctx.beginPath();
    ctx.roundRect(layout.restartButton.x, layout.restartButton.y, layout.restartButton.width, layout.restartButton.height, 10);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "#13131c";
    ctx.font = "bold 16px monospace";
    ctx.fillText("Restart", layout.restartButton.x + layout.restartButton.width / 2, layout.restartButton.y + layout.restartButton.height / 2 + 6);

    ctx.fillStyle = "#3a3f52";
    ctx.beginPath();
    ctx.roundRect(layout.returnButton.x, layout.returnButton.y, layout.returnButton.width, layout.returnButton.height, 10);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText("Return to Start", layout.returnButton.x + layout.returnButton.width / 2, layout.returnButton.y + layout.returnButton.height / 2 + 6);

    ctx.textAlign = "start";
  }

  function renderPauseOverlay(ctx, canvas) {
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const centerX = width / 2;
    const layout = getPauseMenuLayout(canvas);

    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, 0, width, height);

    const cardWidth = Math.min(360, width - 40);
    const cardTop = layout.resumeButton.y - 90;
    const cardBottom = layout.menuButton.y + layout.menuButton.height + 24;
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
    ctx.shadowBlur = 30;
    ctx.fillStyle = "#1a1b26";
    ctx.beginPath();
    ctx.roundRect(centerX - cardWidth / 2, cardTop, cardWidth, cardBottom - cardTop, 18);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(centerX - cardWidth / 2, cardTop, cardWidth, cardBottom - cardTop, 18);
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.fillStyle = "#f4f4f5";
    ctx.font = "bold 32px monospace";
    ctx.fillText("Paused", centerX, layout.resumeButton.y - 40);

    ctx.save();
    ctx.shadowColor = "rgba(34, 197, 94, 0.4)";
    ctx.shadowBlur = 10;
    ctx.fillStyle = "#22c55e";
    ctx.beginPath();
    ctx.roundRect(layout.resumeButton.x, layout.resumeButton.y, layout.resumeButton.width, layout.resumeButton.height, 10);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "#13131c";
    ctx.font = "bold 16px monospace";
    ctx.fillText("Resume", layout.resumeButton.x + layout.resumeButton.width / 2, layout.resumeButton.y + layout.resumeButton.height / 2 + 6);

    ctx.fillStyle = "#3b82f6";
    ctx.beginPath();
    ctx.roundRect(layout.restartButton.x, layout.restartButton.y, layout.restartButton.width, layout.restartButton.height, 10);
    ctx.fill();
    ctx.fillStyle = "#13131c";
    ctx.fillText("Restart", layout.restartButton.x + layout.restartButton.width / 2, layout.restartButton.y + layout.restartButton.height / 2 + 6);

    ctx.fillStyle = "#3a3f52";
    ctx.beginPath();
    ctx.roundRect(layout.menuButton.x, layout.menuButton.y, layout.menuButton.width, layout.menuButton.height, 10);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText("Main Menu", layout.menuButton.x + layout.menuButton.width / 2, layout.menuButton.y + layout.menuButton.height / 2 + 6);

    ctx.textAlign = "start";
  }

  // Rounded, slightly-elevated card used behind HUD readouts.
  function drawHudPanel(ctx, x, y, w, h, radius) {
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.25)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = "rgba(19, 19, 28, 0.55)";
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.stroke();
  }

  // Banner shown instead of the cursor when the sensors cannot place the
  // player. The full-screen red alert is reserved for the too-close case and is
  // handled by canvas.js switching screens, so it never appears here.
  function renderSensorStatusOverlay(ctx, canvas) {
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const status = gameState.sensor.status;

    let message = null;
    let detail = "";
    if (status === "no-signal") {
      message = "Come closer";
      detail = "No coordinate detected - step into the play area";
    } else if (status === "out-of-bounds") {
      message = "Come back in bounds";
      detail = "Reading outside the play area - move back onto the board";
    }
    if (!message) return;

    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, 0, width, height);

    ctx.textAlign = "center";
    ctx.fillStyle = "#f59e0b";
    ctx.font = `bold ${Math.max(30, Math.min(58, width * 0.055))}px monospace`;
    ctx.fillText(message, width / 2, height / 2 - 10);

    ctx.fillStyle = "#f4f4f5";
    ctx.font = `${Math.max(14, Math.min(20, width * 0.017))}px monospace`;
    ctx.fillText(detail, width / 2, height / 2 + 32);

    ctx.fillStyle = "#9298aa";
    ctx.font = `${Math.max(12, Math.min(16, width * 0.013))}px monospace`;
    ctx.fillText("Timer paused", width / 2, height / 2 + 62);

    ctx.textAlign = "start";
  }

  // Always-on sensor readout. Shows every sensor's raw and conditioned value at
  // once so the rig can be diagnosed mid-round without opening the console.
  // The same data is available as getSensorDebug() from the browser console.
  const SENSOR_ROW_LABELS = ["L", "C", "R"];

  function formatCm(value) {
    return value === null || value === undefined ? "--" : value.toFixed(1);
  }

  function renderSensorPanel(ctx, canvas) {
    const height = canvas.clientHeight || canvas.height;
    const sensor = gameState.sensor;

    const panelW = 322;
    const panelH = 132;
    const x = 12;
    const y = height - panelH - 12;
    const rowH = 20;

    drawHudPanel(ctx, x, y, panelW, panelH, 12);

    ctx.textAlign = "left";
    ctx.font = "bold 10.5px monospace";
    ctx.fillStyle = "#9298aa";
    ctx.fillText("SENSOR", x + 16, y + 20);
    ctx.fillText("RAW cm", x + 92, y + 20);
    ctx.fillText("FILT cm", x + 172, y + 20);
    ctx.fillText("USED", x + 254, y + 20);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 14, y + 27);
    ctx.lineTo(x + panelW - 14, y + 27);
    ctx.stroke();

    const raw = sensor.raw || [null, null, null];
    const filtered = sensor.filtered || [null, null, null];

    for (let i = 0; i < 3; i++) {
      const rowY = y + 27 + rowH * (i + 1);
      const live = filtered[i] !== null && filtered[i] !== undefined;
      const echoing = raw[i] !== null && raw[i] !== undefined;

      // Green = echoing now, amber = coasting on a held value, red = nothing.
      let dot = "#ef4444";
      if (echoing) dot = "#22c55e";
      else if (live) dot = "#f59e0b";
      ctx.fillStyle = dot;
      ctx.beginPath();
      ctx.arc(x + 21, rowY - 4, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = "bold 12px monospace";
      ctx.fillStyle = "#f4f4f5";
      ctx.fillText(SENSOR_ROW_LABELS[i], x + 33, rowY);

      ctx.font = "12px monospace";
      ctx.fillStyle = echoing ? "#cdd6f4" : "#63736f";
      ctx.fillText(formatCm(raw[i]), x + 92, rowY);

      ctx.fillStyle = live ? "#cdd6f4" : "#63736f";
      ctx.fillText(formatCm(filtered[i]), x + 172, rowY);

      if (sensor.column === i) {
        ctx.fillStyle = "#facc15";
        ctx.font = "bold 12px monospace";
        ctx.fillText("<--", x + 254, rowY);
      }
    }

    // Resolved fix
    const fixY = y + panelH - 12;
    ctx.font = "bold 12px monospace";
    const status = sensor.status;

    if (status === "ok" && sensor.gx !== null) {
      ctx.fillStyle = sensor.held ? "#f59e0b" : "#22c55e";
      const label = `grid (${sensor.gx}, ${sensor.gy})  @ ${formatCm(sensor.distanceCm)}cm`;
      ctx.fillText(
        sensor.held ? `${label}  HELD ${sensor.heldFor}/${MAX_HELD_READINGS}` : label,
        x + 16,
        fixY
      );
    } else {
      ctx.fillStyle = "#ef4444";
      ctx.fillText(String(status).toUpperCase().replace(/-/g, " "), x + 16, fixY);
    }

    if (sensor.calibrated === false) {
      ctx.fillStyle = "#f59e0b";
      ctx.font = "10px monospace";
      ctx.textAlign = "right";
      ctx.fillText("uncalibrated", x + panelW - 16, fixY);
    }

    ctx.textAlign = "start";
  }

  function renderInputReadout(ctx, canvas) {
    const height = canvas.clientHeight || canvas.height;

    if (gameState.inputMode === "sensor") {
      renderSensorPanel(ctx, canvas);
      return;
    }

    drawHudPanel(ctx, 12, height - 52, 176, 40, 10);
    ctx.textAlign = "left";
    ctx.font = "bold 14px monospace";
    ctx.fillStyle = "#9298aa";
    ctx.fillText("Input: MOUSE", 26, height - 27);
    ctx.textAlign = "start";
  }

  window.renderGame = function renderGame(ctx, canvas) {
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;

    // Computed first (rather than down by the mole-drawing loop) so the
    // sky/grass horizon can be pinned to sit right above the grid, keeping
    // every hole fully inside the grass instead of poking into the sky.
    const layout = window.getGameGridLayout(canvas);
    const horizonY = Math.max(70, layout.gridTop - 36);

    // Sky-to-grass backdrop, echoing the whack-a-mole art direction.
    const sky = ctx.createLinearGradient(0, 0, 0, horizonY);
    sky.addColorStop(0, "#8fd3f4");
    sky.addColorStop(1, "#bfe9c9");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, horizonY);

    const grass = ctx.createLinearGradient(0, horizonY, 0, height);
    grass.addColorStop(0, "#8bc34a");
    grass.addColorStop(1, "#5a8f2f");
    ctx.fillStyle = grass;
    ctx.fillRect(0, horizonY, width, height - horizonY);

    // Pause button, top-left corner (only actionable mid-round, but its
    // position is always reserved so the score panel next to it never shifts).
    const pauseLayout = getGamePauseLayout();
    if (gameState.status === "playing") {
      drawHudPanel(ctx, pauseLayout.x, pauseLayout.y, pauseLayout.width, pauseLayout.height, 10);
      const barW = pauseLayout.width * 0.16;
      const barH = pauseLayout.height * 0.5;
      const barGap = pauseLayout.width * 0.12;
      const pcx = pauseLayout.x + pauseLayout.width / 2;
      const pcy = pauseLayout.y + pauseLayout.height / 2;
      ctx.fillStyle = "#f4f4f5";
      ctx.fillRect(pcx - barGap - barW, pcy - barH / 2, barW, barH);
      ctx.fillRect(pcx + barGap, pcy - barH / 2, barW, barH);
    }

    // HUD: pause + score + lives share one row on the left, timer center, level right.
    const scoreFontSize = Math.max(22, Math.min(30, width * 0.024));
    const livesFontSize = Math.max(32, Math.min(46, width * 0.036));
    const scorePanel = {
      x: pauseLayout.x + pauseLayout.width + 10,
      y: pauseLayout.y,
      w: Math.max(190, Math.min(260, width * 0.2)),
      h: scoreFontSize + livesFontSize + 40,
    };
    drawHudPanel(ctx, scorePanel.x, scorePanel.y, scorePanel.w, scorePanel.h, 14);

    ctx.textAlign = "left";
    ctx.fillStyle = "#f4f4f5";
    ctx.font = `bold ${scoreFontSize}px monospace`;
    ctx.fillText(`Score: ${gameState.score}`, scorePanel.x + 16, scorePanel.y + scoreFontSize + 8);

    ctx.fillStyle = "#ef4444";
    ctx.font = `bold ${livesFontSize}px monospace`;
    ctx.fillText(
      settings.testMode ? "♥∞" : "♥".repeat(Math.max(0, gameState.lives)),
      scorePanel.x + 16,
      scorePanel.y + scoreFontSize + livesFontSize + 22
    );

    // Unmissable badge - a score from a test run must never be mistaken for a real one.
    if (settings.testMode) {
      const badgeW = 168;
      const badgeH = 26;
      const badgeX = width / 2 - badgeW / 2;
      const badgeY = 78;
      ctx.fillStyle = "#f59e0b";
      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 6);
      ctx.fill();
      ctx.fillStyle = "#13131c";
      ctx.font = "bold 12px monospace";
      ctx.textAlign = "center";
      ctx.fillText("TEST MODE", width / 2, badgeY + 17);
      ctx.textAlign = "left";
    }

    const levelPanel = { w: 130, h: 40 };
    levelPanel.x = width - 12 - levelPanel.w;
    levelPanel.y = 12;
    drawHudPanel(ctx, levelPanel.x, levelPanel.y, levelPanel.w, levelPanel.h, 12);
    ctx.textAlign = "right";
    ctx.fillStyle = "#f4f4f5";
    ctx.font = "bold 20px monospace";
    ctx.fillText(`Level: ${gameState.level}`, levelPanel.x + levelPanel.w - 14, levelPanel.y + 27);

    ctx.textAlign = "center";
    const secondsLeft = Math.ceil(gameState.remainingMs / 1000);
    const timerFontSize = Math.max(32, Math.min(52, width * 0.045));
    const timerPanelW = timerFontSize * 3.4;
    const timerPanelH = timerFontSize * 1.35;
    drawHudPanel(ctx, width / 2 - timerPanelW / 2, 8, timerPanelW, timerPanelH, timerPanelH / 2);
    if (settings.testMode) {
      ctx.fillStyle = "#f59e0b";
    } else {
      ctx.fillStyle = secondsLeft <= 10 ? "#ef4444" : "#f4f4f5";
    }
    ctx.font = `bold ${timerFontSize}px monospace`;
    ctx.fillText(
      settings.testMode ? "∞" : `${secondsLeft}s`,
      width / 2,
      8 + timerPanelH / 2 + timerFontSize * 0.35
    );

    // Grid + moles
    const now = performance.now();
    const holeImg = moleImages.hole;

    layout.holes.forEach((hole) => {
      const centerX = hole.x + hole.size / 2;
      const groundH = hole.size * 0.34;
      const groundTopY = hole.y + hole.size - groundH;

      // Soft dirt mound behind every tile so moles read as "popping up" even
      // once the hole artwork has loaded.
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.3)";
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 6;
      const moundGradient = ctx.createRadialGradient(
        centerX, groundTopY + groundH * 0.4, hole.size * 0.05,
        centerX, groundTopY + groundH * 0.4, hole.size * 0.6
      );
      moundGradient.addColorStop(0, "#7a5230");
      moundGradient.addColorStop(1, "#4a3116");
      ctx.fillStyle = moundGradient;
      ctx.beginPath();
      ctx.roundRect(hole.x, hole.y, hole.size, hole.size, 14);
      ctx.fill();
      ctx.restore();

      if (isImageReady(holeImg)) {
        const groundW = groundH * (holeImg.width / holeImg.height);
        ctx.drawImage(holeImg, centerX - groundW / 2, groundTopY, groundW, groundH);
      } else {
        ctx.fillStyle = "#3b2a1a";
        ctx.beginPath();
        ctx.ellipse(centerX, groundTopY + groundH * 0.4, hole.size * 0.3, groundH * 0.4, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      const isFlashing = gameState.hitFlash.hole === hole.index && now < gameState.hitFlash.until;
      if (isFlashing) {
        let flashColor = "rgba(34, 197, 94, 0.35)";
        if (gameState.hitFlash.type === "bomb") flashColor = "rgba(239, 68, 68, 0.4)";
        else if (gameState.hitFlash.type === "wounded") flashColor = "rgba(234, 179, 8, 0.45)";
        ctx.fillStyle = flashColor;
        ctx.beginPath();
        ctx.roundRect(hole.x, hole.y, hole.size, hole.size, 10);
        ctx.fill();
      }

      if (hole.index === gameState.activeHole) {
        const type = gameState.moleType;
        let imgKey = "mole";
        if (type === "bomb") imgKey = "bomb";
        else if (type === "super") imgKey = gameState.moleWounded ? "super_mole_hit" : "super_mole";
        const img = moleImages[imgKey];

        if (isImageReady(img)) {
          const height = type === "bomb" ? hole.size * 0.42 : hole.size * 0.62;
          drawImageCentered(ctx, img, centerX, groundTopY - height * 0.35, height);
        } else {
          const moleRadius = hole.size * 0.32;
          const moleCY = hole.y + hole.size / 2;
          ctx.fillStyle = type === "bomb" ? "#1f2937" : "#8b5e3c";
          ctx.beginPath();
          ctx.ellipse(centerX, moleCY, moleRadius, moleRadius * 0.9, 0, 0, Math.PI * 2);
          ctx.fill();
          if (type !== "bomb") {
            ctx.fillStyle = "#13131c";
            ctx.beginPath();
            ctx.arc(centerX - moleRadius * 0.35, moleCY - moleRadius * 0.15, moleRadius * 0.12, 0, Math.PI * 2);
            ctx.arc(centerX + moleRadius * 0.35, moleCY - moleRadius * 0.15, moleRadius * 0.12, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      } else if (isFlashing && gameState.hitFlash.type !== "bomb" && gameState.hitFlash.type !== "wounded") {
        const img = moleImages[gameState.hitFlash.type === "super" ? "dead_super_mole" : "dead_mole"];
        if (isImageReady(img)) {
          const height = hole.size * 0.62;
          drawImageCentered(ctx, img, centerX, groundTopY - height * 0.35, height);
        }
      }
    });

    // Floating "How to Play" legend, right-hand side.
    const legendWidth = Math.max(220, Math.min(300, width * 0.22));
    const legendX = width - 12 - legendWidth;
    const legendY = Math.max(140, height * 0.22);
    const legendEntries = [
      { imgKey: "mole", color: "#8b5e3c", title: "Mole", lines: ["Whack it for", "+1 point."] },
      { imgKey: "super_mole", color: "#eab308", title: "Hat Mole", lines: ["2 hits to defeat,", `worth +${SUPER_MOLE_POINTS} points.`] },
      { imgKey: "bomb", color: "#ef4444", title: "Bomb", lines: [`Avoid! -${BOMB_PENALTY} points`, "and a lost life."] },
    ];
    const legendEntryHeight = 82;
    const legendHeaderHeight = 40;
    const legendHeight = legendHeaderHeight + legendEntries.length * legendEntryHeight + 14;
    drawHudPanel(ctx, legendX, legendY, legendWidth, legendHeight, 14);

    ctx.textAlign = "left";
    ctx.fillStyle = "#f4f4f5";
    ctx.font = "bold 16px monospace";
    ctx.fillText("How to Play", legendX + 16, legendY + 26);

    const legendIconSize = 32;
    legendEntries.forEach((entry, index) => {
      const entryY = legendY + legendHeaderHeight + index * legendEntryHeight;
      const iconImg = moleImages[entry.imgKey];
      if (isImageReady(iconImg)) {
        drawImageCentered(ctx, iconImg, legendX + 16 + legendIconSize / 2, entryY + legendIconSize / 2, legendIconSize);
      } else {
        // Falls back to a flat swatch until the asset finishes loading.
        ctx.fillStyle = entry.color;
        ctx.beginPath();
        ctx.roundRect(legendX + 16, entryY, legendIconSize, legendIconSize, 6);
        ctx.fill();
      }

      ctx.fillStyle = "#f4f4f5";
      ctx.font = "bold 15px monospace";
      ctx.fillText(entry.title, legendX + 16 + legendIconSize + 10, entryY + legendIconSize / 2 + 5);

      ctx.fillStyle = "#9298aa";
      ctx.font = "12px monospace";
      entry.lines.forEach((line, lineIndex) => {
        // Cleared below the (now taller) icon rather than the old fixed
        // offset, which only had headroom for the small flat swatch.
        ctx.fillText(line, legendX + 16, entryY + legendIconSize + 14 + lineIndex * 15);
      });
    });

    // Cursor - mouse pixels, or the sensor fix mapped through grid space.
    if (gameState.cursor.x !== null) {
      if (gameState.cursor.inBounds) {
        ctx.save();
        ctx.shadowColor = "rgba(250, 204, 21, 0.9)";
        ctx.shadowBlur = 12;
        ctx.strokeStyle = "#facc15";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(gameState.cursor.x, gameState.cursor.y, 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "rgba(250, 204, 21, 0.25)";
        ctx.beginPath();
        ctx.arc(gameState.cursor.x, gameState.cursor.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else if (gameState.inputMode === "mouse") {
        // Sensor mode gets the full-screen status overlay below instead.
        drawHudPanel(ctx, width / 2 - 100, height - 58, 200, 40, 10);
        ctx.fillStyle = "#ef4444";
        ctx.font = "bold 16px monospace";
        ctx.textAlign = "center";
        ctx.fillText("Out of bounds", width / 2, height - 32);
      }
    }

    renderInputReadout(ctx, canvas);

    if (gameState.inputMode === "sensor" && gameState.status === "playing") {
      renderSensorStatusOverlay(ctx, canvas);
    }

    if (gameState.status === "paused") {
      renderPauseOverlay(ctx, canvas);
    } else if (gameState.status === "gameover") {
      renderGameOverOverlay(ctx, canvas);
    }

    ctx.textAlign = "start";
  };
})();
