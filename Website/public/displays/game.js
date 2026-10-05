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
//   window.setServerFilteringActive(active)     - the server has SERVER_FILTERING on
//   window.setServerCoordinate(coordinate)      - latest filtered coordinate from the server
//
// Three input modes share all of the game logic. Only the cursor source differs:
//   "mouse"  - canvas.js feeds raw canvas pixels straight from mousemove.
//              Reached via Skip on the calibration screen.
//   "sensor" - readSensorCoordinate() places the player from the LEFT and
//              RIGHT scanner nodes (distance + servo angle; trilateration for
//              nodes that send no angle) as ONE continuous position in
//              centimetres, and rawToGrid() (callibrate_corners.js) turns that
//              into 0-2 grid coordinates with (0,0) at BOTTOM-LEFT. That cell,
//              after the majority vote, is the game rule: it decides which
//              mole is live. The continuous position is drawn as the cursor
//              through the spring in positionSolver.js, so the player glides
//              between holes instead of snapping to their centres. Entered
//              once both nodes are identified and the corners calibrated.
//              When the server runs filterRules.py (SERVER_FILTERING on), its
//              coordinate replaces readSensorCoordinate() for the cursor and
//              alert; with the flag off (the default) nothing here changes.
//   "remote" - the phone control panel (/control, only served when the server
//              runs with CON=1) acts as a touchpad: the finger's position on
//              the pad maps onto the grid and the cursor eases towards it.
//              canvas.js switches into this mode while a finger is on the
//              pad and back to "sensor" when it lifts.

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
  // Time constant for easing the remote cursor towards the finger. Touch
  // events arrive in uneven bursts over the network, so this smooths the jumps
  // without making the cursor feel laggy.
  const REMOTE_SMOOTHING_MS = 60;

  // --- Sensor input ----------------------------------------------------------
  // Two sensors, LEFT and RIGHT, on the screen line pointing straight forward
  // at the centres of the outer columns. There is no centre sensor: the slot
  // order stays [left, centre, right] with the centre always empty, so a slot
  // index is still a grid column. Basic trilateration places the player (see
  // trilaterate()); callibrate_corners.js maps the depth onto a row.
  const LEFT_SENSOR = 0;
  const RIGHT_SENSOR = 2;
  const PLAY_WIDTH_CM = 150; // matches PlayArea.width_cm in filterRules.py
  const MAX_COORD_CM = 150; // hard ceiling before any calibration exists

  // Once the play area is calibrated, the far edge decides what counts as out
  // of bounds rather than this blanket 1.5 m limit.
  function maxCoordCm() {
    const bounds = window.getCalibrationBounds ? window.getCalibrationBounds() : null;
    if (bounds && bounds.calibrated && Number.isFinite(bounds.maxCm)) {
      return Math.min(MAX_COORD_CM, bounds.maxCm);
    }
    return MAX_COORD_CM;
  }

  // Reading conditioning. The firmware ships RAW distances - the 3-sample
  // average in ultrasonicSensor.cpp is commented out - so spikes and dropped
  // echoes arrive here unsmoothed. Without the filtering below, one bad frame
  // out of the 20/sec each node sends was enough to pause the round.
  const SENSOR_HISTORY = 5;       // samples per sensor in the median window
  const SENSOR_HOLD_MS = 350;     // coast a sensor through a dropped echo

  // Slew limiting. A person cannot cross the room between two readings, so a
  // jump from 20cm to 194cm is a reflection or crosstalk, not movement. Such a
  // reading is discarded before it ever reaches the median window.
  const MAX_SPEED_CM_PER_S = 300;    // 3 m/s - faster than anyone lunges
  const SLEW_MIN_JUMP_CM = 25;       // always tolerate at least this much change
  // ...and never more than this, however long since the last accepted reading.
  // Without a ceiling the allowance grows with elapsed time, so a sensor that
  // keeps reporting nonsense eventually accepts it - which defeats the filter.
  const SLEW_MAX_JUMP_CM = 40;
  // Never lock out forever: if the rejected readings agree with each other for
  // this long, the world really did change and we re-lock onto it.
  const SLEW_RELOCK_READINGS = 8;
  const SLEW_RELOCK_SPREAD_CM = 20;
  // How long the slew reference outlives the median window. The window clears
  // after SENSOR_HOLD_MS, but the last believed position must persist longer -
  // otherwise sustained noise clears the reference and is then accepted as
  // truth, which is precisely the jump we set out to reject.
  const SLEW_ANCHOR_TTL_MS = 3000;
  // --- Live-tunable smoothing -----------------------------------------------
  // The server broadcasts on every node message, so with two sensors at 20Hz
  // roughly 40 readings arrive each second. All four numbers below are counted
  // in readings (not render frames), so 100 readings is about 2.5 seconds.
  //
  // Adjust at runtime from the console with tuneSensor({ ... }) - no reload.
  const tuning = {
    // Votes held in the cell window. Bigger = steadier cursor, slower to follow
    // a real move. At ~40 readings/sec, 25 is roughly 0.6s of history.
    cellWindow: 25,
    // Votes a rival cell needs to take over. Must stay above half of
    // cellWindow, otherwise two cells can trade the lead and the cursor flips.
    cellVotes: 13,
    // Consecutive unusable readings ridden out on the last good cell before the
    // come-closer / out-of-bounds screen appears.
    holdReadings: 100,
    // Backstop for when data stops arriving altogether, so a disconnected rig
    // cannot leave a stale cursor on screen forever. Must comfortably exceed
    // holdReadings at the current data rate, or it fires first and the reading
    // budget never gets a chance to matter.
    holdTimeoutMs: 5000,
  };

  window.tuneSensor = function tuneSensor(partial) {
    if (partial && typeof partial === "object") Object.assign(tuning, partial);
    if (tuning.cellVotes > tuning.cellWindow) tuning.cellVotes = tuning.cellWindow;
    console.info("[tune] " + JSON.stringify(tuning));
    if (tuning.cellVotes <= tuning.cellWindow / 2) {
      console.warn("[tune] cellVotes is at or below half of cellWindow - the cursor may flip between cells");
    }
    return { ...tuning };
  };
  const COLUMN_MARGIN_CM = 8;     // x must clear a column boundary by this to change column
  const TOO_CLOSE_FRAMES = 2;     // consecutive raw frames needed to raise the alert

  // --- Continuous position ---------------------------------------------------
  // The grid CELL is still what gets whacked, and it is still decided with the
  // hysteresis and majority vote that stop a single bad frame changing which
  // mole is live - the part ported to filterRules.py and pinned by
  // fixtures/js_parity_trace.json. But the cursor no longer has to sit on that
  // cell's centre: it is drawn from the continuous position in centimetres
  // (readSensorCoordinate()), so it glides across the board instead of jumping
  // between nine fixed points. The cursor is a presentation concern; the cell
  // is the game rule.
  //
  // The position is the same one the column and row are derived from, so the
  // cursor cannot drift somewhere the grid mapping does not also believe the
  // player is. (An earlier version solved the cursor separately from the echo
  // distances alone, and had to check that solve against the column vote,
  // because with two nodes a distance-only solve fits ANY pair of ranges
  // exactly. The scanners' servo angles, and deriving the column from the one
  // position, took that check's place.)
  const CURSOR_SMOOTH_TIME = 0.14; // s to close most of the gap to a new position
  const CURSOR_MAX_SPEED = 900;     // px/s ceiling, so one bad frame cannot fling it

  // HUD layout (see renderHud()). Bottom-left, from the corner up: the
  // miniature cursor, the sensor panel, then the position map.
  const HUD_EDGE = 12;            // px from the canvas edge
  const HUD_GAP = 10;             // px between stacked panels
  const SENSOR_PANEL_W = 380;     // px
  const SENSOR_PANEL_H = 132;     // px
  const STATS_PANEL_W = 270;      // px; LIVE STATS, left gutter
  const STATS_PANEL_MIN_W = 190;  // px; narrower and the values collide with the labels
  const CHARTS_PANEL_MAX_H = 300; // px; LIVE DATA, under the legend
  const MAP_AREA_WIDTH_CM = PLAY_WIDTH_CM;
  const MAP_MIN_SIZE = 110;       // px; below this the grid stops being legible
  const MAP_MAX_SIZE = 170;       // px
  const MAP_GAP = 10;             // px between the map and the sensor panel

  // Declared up here, not beside the render code, because resetSensorFilters()
  // touches them and a `let` read before its line runs throws.
  let coordinateMap = null;
  let lastMapPoint = null;

  // Drawn-cursor smoothing. Created once and reset between rounds, so it is
  // declared with the rest of the module state rather than per round.
  const cursorSmoother = new window.CursorSmoother({
    smoothTime: CURSOR_SMOOTH_TIME,
    maxSpeed: CURSOR_MAX_SPEED,
  });
  let cursorLastStepAt = null;

  // Cell stabilisation. Filtering the distance is not enough on its own: a
  // single bad reading that survives the median still lands the cursor in the
  // wrong cell for a frame, which reads as jumping. Because the output is
  // discrete, the robust answer is to take the MODE of recent cells - the cell
  // seen most often - rather than the latest one. A one-off jump never wins the
  // vote, so it is discarded outright.



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
    xCm: null,
    yCm: null, // continuous play-area position, drives the cursor
    resolved: false, // false when x fell back to the column centre
    configured: 0, // how many sensors reported a usable number
  });

  const gameState = {
    status: "idle", // "idle" | "playing" | "paused" | "gameover"
    inputMode: "mouse", // "mouse" | "sensor" | "remote"
    remoteTarget: null, // { nx, ny } 0-1 across the grid, straight from the phone pad
    remotePos: null, // smoothed copy of remoteTarget, eased every frame
    remoteLastFrame: null,
    remoteHole: -1, // hole the smoothed cursor is over, mirrored back to the phone
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
    roundStats()?.reset(gameState.inputMode);
  };

  // The live statistics (gameStats.js). Optional: the headless parity run loads
  // game.js without it, so every report goes through this and may be skipped.
  function roundStats() {
    return window.GameStats || null;
  }

  window.getGameState = function getGameState() {
    return gameState;
  };

  window.setGameInputMode = function setGameInputMode(mode) {
    gameState.inputMode = mode === "sensor" || mode === "remote" ? mode : "mouse";
    // Drop any stale cursor so the modes never inherit each other's position.
    gameState.cursor = { x: null, y: null, inBounds: true };
    gameState.remoteTarget = null;
    gameState.remotePos = null;
    gameState.remoteLastFrame = null;
    gameState.remoteHole = -1;
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
      if (serverCoordinateActive) {
        applyServerCoordinate(canvas, orderedNodes);
      } else {
        updateSensorCursor(canvas, orderedNodes);
      }
      recordSensorReading(now, orderedNodes);
    } else if (gameState.inputMode === "remote" && canvas) {
      updateRemoteCursor(canvas, now);
    }

    if (gameState.status !== "playing") return;

    if (gameState.lastTickTime === null) {
      gameState.lastTickTime = now;
      gameState.nextSpawnAt = now + randomBetween(MIN_SPAWN_DELAY_MS, MAX_SPAWN_DELAY_MS);
    }

    const elapsed = now - gameState.lastTickTime;
    gameState.lastTickTime = now;
    roundStats()?.onTick(elapsed, statsFrame(canvas));

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
      roundStats()?.onExpire(gameState.moleType);
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
      roundStats()?.onSpawn(gameState.moleType);
    }
  };

  // --- Live statistics feed ----------------------------------------------------

  // Grid cell (gx, gy; origin bottom-left) -> hole index (0 top-left, reading order).
  function holeForCell(gx, gy) {
    return (2 - gy) * 3 + gx;
  }

  function holeAtPoint(layout, x, y) {
    return layout.holes.find((h) => x >= h.x && x <= h.x + h.size && y >= h.y && y <= h.y + h.size) || null;
  }

  // What GameStats.onTick() needs about this frame. positionCm puts both input
  // modes on one centimetre scale (the board is PLAY_WIDTH_CM across), so
  // cursor travel means the same thing in either.
  function statsFrame(canvas) {
    const sensor = gameState.sensor;
    const sensorMode = gameState.inputMode === "sensor";
    let cell = null;
    let positionCm = null;
    let onBoard = false;

    if (sensorMode) {
      if (Number.isInteger(sensor.gx) && Number.isInteger(sensor.gy)) cell = holeForCell(sensor.gx, sensor.gy);
      const live = sensor.status === "ok" && !sensor.held;
      if (live && Number.isFinite(sensor.xCm) && Number.isFinite(sensor.yCm)) {
        positionCm = { x: sensor.xCm, y: sensor.yCm };
      }
      onBoard = sensor.status === "ok";
    } else if (canvas && gameState.cursor.x !== null) {
      const layout = window.getGameGridLayout(canvas);
      const hole = holeAtPoint(layout, gameState.cursor.x, gameState.cursor.y);
      cell = hole ? hole.index : null;
      const scale = PLAY_WIDTH_CM / layout.gridSize;
      positionCm = {
        x: (gameState.cursor.x - layout.gridLeft) * scale,
        y: (layout.gridTop + layout.gridSize - gameState.cursor.y) * scale,
      };
      onBoard = positionCm.x >= 0 && positionCm.x <= PLAY_WIDTH_CM
        && positionCm.y >= 0 && positionCm.y <= PLAY_WIDTH_CM;
    }

    return {
      blocked: isSensorBlocked(),
      held: sensorMode && Boolean(sensor.held),
      sensorStatus: sensorMode ? sensor.status : "ok",
      cell,
      onBoard,
      positionCm,
      score: gameState.score,
      level: gameState.level,
      lives: settings.testMode ? null : gameState.lives,
    };
  }

  // One stats sample per NEW sensor reading (canvas.js bumps sensorFrameSeq on
  // every nodes:update), from whichever path - browser or server - produced
  // gameState.sensor this frame. Only while a round is actually playing.
  let statsFrameSeq = -1;

  function recordSensorReading(now, orderedNodes) {
    if (sensorFrameSeq === statsFrameSeq) return;
    statsFrameSeq = sensorFrameSeq;
    if (gameState.status !== "playing") return;

    const sensor = gameState.sensor;
    const raw = sensor.raw || [null, null, null];
    const list = Array.isArray(orderedNodes) ? orderedNodes : [];
    const rateOf = (node) => (node && Number.isFinite(node.rps) ? node.rps : null);
    const usable = sensor.status === "ok" && !sensor.held;
    roundStats()?.onSensorReading(now, {
      raw: [raw[LEFT_SENSOR], raw[RIGHT_SENSOR]],
      source: usable ? sensor.source || null : null,
      rejects: [sensorFilters[LEFT_SENSOR].rejectCount, sensorFilters[RIGHT_SENSOR].rejectCount],
      rate: [rateOf(list[LEFT_SENSOR]), rateOf(list[RIGHT_SENSOR])],
    });
  }

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

  // Remote-mode input: the finger's position on the phone pad, normalised to
  // 0-1 with (0,0) at the top-left, same orientation as the on-screen grid.
  // Anything non-numeric lifts the cursor off the board.
  window.setRemotePoint = function setRemotePoint(nx, ny) {
    if (gameState.inputMode !== "remote") return;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
      gameState.remoteTarget = null;
      return;
    }
    const clamp = (v) => Math.min(1, Math.max(0, v));
    gameState.remoteTarget = { nx: clamp(nx), ny: clamp(ny) };
  };

  // Stored normalised rather than as pixels, so a resize keeps the cursor on
  // the same spot of the grid. Hovering scores, exactly as in sensor mode.
  function updateRemoteCursor(canvas, now) {
    const target = gameState.remoteTarget;
    if (!target) {
      gameState.cursor = { x: null, y: null, inBounds: true };
      gameState.remotePos = null;
      gameState.remoteLastFrame = null;
      gameState.remoteHole = -1;
      return;
    }

    // Frame-rate independent exponential ease; the first touch jumps straight there.
    if (!gameState.remotePos || gameState.remoteLastFrame === null) {
      gameState.remotePos = { ...target };
    } else {
      const dt = Math.min(100, Math.max(0, now - gameState.remoteLastFrame));
      const a = 1 - Math.exp(-dt / REMOTE_SMOOTHING_MS);
      gameState.remotePos.nx += (target.nx - gameState.remotePos.nx) * a;
      gameState.remotePos.ny += (target.ny - gameState.remotePos.ny) * a;
    }
    gameState.remoteLastFrame = now;

    const layout = window.getGameGridLayout(canvas);
    const x = layout.gridLeft + gameState.remotePos.nx * layout.gridSize;
    const y = layout.gridTop + gameState.remotePos.ny * layout.gridSize;
    gameState.cursor = { x, y, inBounds: true };

    const hole = layout.holes.find(
      (h) => x >= h.x && x <= h.x + h.size && y >= h.y && y <= h.y + h.size
    );
    gameState.remoteHole = hole ? hole.index : -1;
    window.handleGameHover(canvas, x, y);
  }

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

    return { holes, cellSize, cellGap, gridLeft, gridTop, gridSize };
  };

  function awardPointForHole(holeIndex) {
    if (gameState.status !== "playing") return false;
    if (holeIndex !== gameState.activeHole) return false;

    const now = performance.now();
    const hitType = gameState.moleType;
    // Pauses and sensor holds already shift moleSpawnedAt, so this is time the
    // mole was actually up. Measured to the FIRST hit, before a wound resets it.
    const reactionMs = now - gameState.moleSpawnedAt;

    // Hat (super) moles take two hits to defeat. The first hit just wounds it and
    // refreshes its timer for the finishing blow - no score/life change yet.
    if (hitType === "super" && !gameState.moleWounded) {
      roundStats()?.onFirstHit("super", reactionMs);
      gameState.moleWounded = true;
      gameState.moleSpawnedAt = now;
      gameState.hitFlash = { hole: holeIndex, until: now + HIT_FEEDBACK_MS, type: "wounded" };
      return true;
    }

    if (hitType === "bomb") {
      gameState.score = Math.max(0, gameState.score - BOMB_PENALTY);
      loseLife();
      roundStats()?.onBombHit();
    } else {
      gameState.score += hitType === "super" ? SUPER_MOLE_POINTS : 1;
      if (hitType === "mole") roundStats()?.onFirstHit("mole", reactionMs);
      roundStats()?.onDefeat(hitType, holeIndex);
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

  // The scanner fields of a node's latest payload (src/scanning.cpp): the servo
  // angle the reading was taken at (90 = straight out, more = screen-left),
  // the scan state (0 found, 1 half-found, 2 lost) and both ultrasonics
  // (-1 = no echo). Each is null when the node's firmware does not send it.
  const NO_SCAN = { angle: null, state: null, left: null, right: null };

  function readScan(node) {
    if (!node || !node.online || !node.latest) return NO_SCAN;
    let payload;
    try {
      payload = JSON.parse(node.latest);
    } catch (err) {
      return NO_SCAN;
    }
    const numberOrNull = (value) => {
      if (value === null || value === undefined || value === "") return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    };
    return {
      angle: numberOrNull(payload.angle),
      // scanState is the firmware's name; state is accepted from earlier builds.
      state: numberOrNull(payload.scanState ?? payload.state),
      left: numberOrNull(payload.left),
      right: numberOrNull(payload.right),
    };
  }

  window.readNodeScan = readScan;

  // --- Per-sensor conditioning ----------------------------------------------

  function makeFilter() {
    return {
      samples: [],
      value: null,
      lastGoodAt: -Infinity,
      anchor: null,     // last believed position, outlives the median window
      anchorAt: -Infinity,
      rejects: [],      // recent implausible readings, kept for re-locking
      rejectCount: 0,   // total discarded, surfaced for diagnosis
    };
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

  // Decides whether a reading is physically reachable from where this sensor
  // last saw the player. Returns false for a jump no human could make.
  function isPlausible(filter, raw, now) {
    const reference = filter.anchor;
    if (reference === null || now - filter.anchorAt > SLEW_ANCHOR_TTL_MS) {
      filter.rejects.length = 0;
      return true; // no live belief to contradict
    }

    const dt = Math.max(1, now - filter.anchorAt);
    const allowed = Math.min(
      SLEW_MAX_JUMP_CM,
      Math.max(SLEW_MIN_JUMP_CM, (MAX_SPEED_CM_PER_S * dt) / 1000)
    );

    if (Math.abs(raw - reference) <= allowed) {
      filter.rejects.length = 0;
      return true;
    }

    // Implausible against our current belief. Hold onto it: if the next several
    // readings all agree with THIS value rather than the old one, our previous
    // belief was the wrong one and we should move.
    filter.rejects.push(raw);
    if (filter.rejects.length > SLEW_RELOCK_READINGS) filter.rejects.shift();

    if (filter.rejects.length >= SLEW_RELOCK_READINGS) {
      const spread = Math.max(...filter.rejects) - Math.min(...filter.rejects);
      if (spread <= SLEW_RELOCK_SPREAD_CM) {
        filter.samples.length = 0;
        filter.rejects.length = 0;
        return true;
      }
    }

    filter.rejectCount += 1;
    return false;
  }

  // A median rejects single-sample spikes far better than a mean, and the hold
  // window coasts through a dropped echo instead of reporting the player gone.
  function conditionSensor(filter, raw, now) {
    // An impossible jump is treated exactly like a dropped echo: it never
    // enters the median window, so it cannot drag the value toward itself.
    if (raw !== null && !isPlausible(filter, raw, now)) raw = null;

    if (raw !== null) {
      filter.samples.push(raw);
      if (filter.samples.length > SENSOR_HISTORY) filter.samples.shift();
      filter.value = median(filter.samples);
      filter.lastGoodAt = now;
      filter.anchor = filter.value;
      filter.anchorAt = now;
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
      filter.anchor = null;
      filter.anchorAt = -Infinity;
      filter.rejects.length = 0;
      filter.rejectCount = 0;
    });
    closeStreak = 0;
    lastColumn = null;
    lastSeenFrameSeq = sensorFrameSeq;
    badReadingStreak = 0;
    resetCellFilter();
    sensorHold.grid = null;
    sensorHold.world = null;
    sensorHold.lastOkAt = -Infinity;
    // Drops the drawn position too, so a new round opens its cursor where the
    // player is standing instead of springing across the board from wherever
    // the last one ended.
    cursorSmoother.reset();
    cursorLastStepAt = null;
    resetCoordinateMap();
  }

  window.resetSensorFilters = resetSensorFilters;

  // --- Coordinate derivation -------------------------------------------------

  let lastColumn = null;
  let closeStreak = 0;

  // --- Placing the player ----------------------------------------------------
  // The two nodes sit on the screen line at the centres of the outer columns.
  // Each is a servo scanner that reports its distance to the player and the
  // angle it was read at, which puts the player at a point (locateNodes()).
  // A node that reports no angle falls back to basic trilateration. x picks
  // the column (the centre one included) and y, the depth from the screen,
  // picks the row. filterRules.py (TwoSensorGeometry) is the parity-tested
  // Python port.

  function columnCentreCm(column) {
    return ((column + 0.5) * PLAY_WIDTH_CM) / 3;
  }

  function columnAtCm(x) {
    return Math.max(0, Math.min(2, Math.floor(x / (PLAY_WIDTH_CM / 3))));
  }

  function isInPlay(column, distance) {
    return window.isWithinPlayArea ? window.isWithinPlayArea(column, distance) : true;
  }

  // Where the player is, from the filtered [left, centre, right] distances.
  // Returns { x, y, source } in cm, or null when neither sensor has a reading.
  // source is "both" for a trilaterated fix, else the one sensor used. Pure:
  // no hysteresis state is touched, and x is not yet clamped to the board.
  //
  // A reading only counts toward the crossing if it is inside its own
  // column's play area. When only one does, or the circles miss each other
  // (one sensor is seeing something else), the nearer sensor places the
  // player straight in front of itself.
  function trilaterate(filtered) {
    const dL = filtered[LEFT_SENSOR];
    const dR = filtered[RIGHT_SENSOR];
    const inL = dL !== null && isInPlay(LEFT_SENSOR, dL);
    const inR = dR !== null && isInPlay(RIGHT_SENSOR, dR);

    if (inL && inR) {
      const xLeft = columnCentreCm(LEFT_SENSOR);
      const base = columnCentreCm(RIGHT_SENSOR) - xLeft;
      const along = (dL * dL - dR * dR + base * base) / (2 * base);
      const h2 = dL * dL - along * along;
      if (h2 >= 0) return { x: xLeft + along, y: Math.sqrt(h2), source: "both" };
    }

    // One sensor on its own: the nearer in-bounds reading, or failing that the
    // nearer reading of any kind. Left wins a tie.
    const candidates = [];
    if (dL !== null) candidates.push({ column: LEFT_SENSOR, distance: dL, inBounds: inL });
    if (dR !== null) candidates.push({ column: RIGHT_SENSOR, distance: dR, inBounds: inR });
    const inBounds = candidates.filter((candidate) => candidate.inBounds);
    const pool = inBounds.length > 0 ? inBounds : candidates;

    let best = null;
    pool.forEach((candidate) => {
      if (best === null || candidate.distance < best.distance) best = candidate;
    });
    if (best === null) return null;
    return {
      x: columnCentreCm(best.column),
      y: best.distance,
      source: best.column === LEFT_SENSOR ? "left" : "right",
    };
  }

  // Where one scanner node's reading puts the player. angle is the servo angle:
  // 90 points straight out, larger turns towards screen-left (smaller x); null
  // means straight out. Same arithmetic as scanner_point() in filterRules.py,
  // operation for operation, so the two agree to the last bit.
  function scannerPoint(nodeX, distance, angle) {
    const phi = ((angle === null ? 90 : angle) - 90) * Math.PI / 180;
    return { x: nodeX - distance * Math.sin(phi), y: distance * Math.cos(phi) };
  }

  // Both nodes in bounds: the midpoint of their two points. One: that point.
  // None: the nearer reading, which still carries a position for the
  // out-of-bounds message. Left wins a tie. Pure, like trilaterate().
  function fromScanners(filtered, angles) {
    const points = [];
    [LEFT_SENSOR, RIGHT_SENSOR].forEach((slot) => {
      const distance = filtered[slot];
      if (distance === null) return;
      const point = scannerPoint(columnCentreCm(slot), distance, angles[slot]);
      const column = columnAtCm(Math.max(0, Math.min(PLAY_WIDTH_CM, point.x)));
      points.push({
        ...point,
        distance,
        inside: isInPlay(column, point.y),
        source: slot === LEFT_SENSOR ? "left" : "right",
      });
    });

    const inBounds = points.filter((point) => point.inside);
    if (inBounds.length === 2) {
      const [a, b] = inBounds;
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, source: "both" };
    }
    const pool = inBounds.length > 0 ? inBounds : points;
    let best = null;
    pool.forEach((point) => {
      if (best === null || point.distance < best.distance) best = point;
    });
    return best === null ? null : { x: best.x, y: best.y, source: best.source };
  }

  // Scanner angles when either node sends one; trilateration when neither does.
  function locateNodes(filtered, angles) {
    if (angles[LEFT_SENSOR] === null && angles[RIGHT_SENSOR] === null) return trilaterate(filtered);
    return fromScanners(filtered, angles);
  }

  // Input:  [left, centre, right] node records, nulls allowed (calibration order).
  //         The centre is ignored: the rig has no centre sensor.
  // Output: {
  //   status:     "ok" | "too-close" | "no-signal" | "out-of-bounds",
  //   column:     the column the player is in - 0 left, 1 centre, 2 right,
  //   distanceCm: the player's depth from the screen (y),
  //   xCm, yCm:   the player's position in cm, source: "both" | "left" | "right",
  //   raw:        [l, c, r] node distances straight off the wire, for debugging,
  //   filtered:   [l, c, r] after median + hold,
  //   depth:      [l, c, r] each node's own depth reading (filtered distance
  //               turned by its servo angle) - what corner calibration captures,
  //   scans:      [l, c, r] each node's scanner fields, see readScan(),
  //   configured: how many sensors currently have a usable value
  // }
  function readSensorCoordinate(orderedNodes) {
    const list = Array.isArray(orderedNodes) ? orderedNodes : [];
    const now = performance.now();

    const raw = [readDistance(list[LEFT_SENSOR]), null, readDistance(list[RIGHT_SENSOR])];
    const scans = [readScan(list[LEFT_SENSOR]), NO_SCAN, readScan(list[RIGHT_SENSOR])];
    const angles = scans.map((scan) => scan.angle);
    const filtered = raw.map((value, index) => conditionSensor(sensorFilters[index], value, now));
    const configured = filtered.filter((d) => d !== null).length;
    const depth = filtered.map((distance, slot) =>
      distance === null || slot === 1 ? null : scannerPoint(columnCentreCm(slot), distance, angles[slot]).y);

    // Fresh data, or the same reading being polled again by the render loop?
    const isNewReading = sensorFrameSeq !== lastSeenFrameSeq;
    lastSeenFrameSeq = sensorFrameSeq;

    const base = {
      raw, filtered, depth, scans, configured, isNewReading,
      column: null, distanceCm: null, xCm: null, yCm: null, source: null,
    };

    // Safety runs on the RAW readings, never the filtered ones: a median window
    // full of safe distances would smooth away the very spike the alert exists
    // to catch. Two consecutive frames (100 ms at 20 Hz) are required so that
    // crosstalk between the two sensors cannot raise a false alarm.
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

    const position = locateNodes(filtered, angles);
    const x = position ? Math.max(0, Math.min(PLAY_WIDTH_CM, position.x)) : null;

    // Safety outranks every other state, including loss of signal. The column
    // is reported without advancing the hysteresis below.
    if (tooClose) {
      const column = position ? columnAtCm(x) : null;
      return { ...base, column, distanceCm: rawMin, status: "too-close" };
    }

    if (position === null) {
      lastColumn = null;
      return { ...base, status: "no-signal" };
    }

    const y = position.y;
    let column = columnAtCm(x);

    // Column hysteresis: next to a column boundary the previous column holds,
    // so noise does not flick the cursor between neighbours.
    if (lastColumn !== null && Math.abs(column - lastColumn) === 1) {
      const boundary = (PLAY_WIDTH_CM / 3) * Math.max(column, lastColumn);
      if (Math.abs(x - boundary) < COLUMN_MARGIN_CM) column = lastColumn;
    }

    const fix = { ...base, column, distanceCm: y, xCm: x, yCm: y, source: position.source };
    if (y > maxCoordCm()) {
      return { ...fix, status: "out-of-bounds" };
    }

    lastColumn = column;
    return { ...fix, status: "ok" };
  }

  window.readSensorCoordinate = readSensorCoordinate;

  // Shared with callibrate_corners.js so both screens reject the same readings.
  window.SENSOR_LIMITS = { maxCm: MAX_COORD_CM };

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

  // --- Continuous position ----------------------------------------------------
  // Draws the one continuous position readSensorCoordinate() works out (from
  // the scanners' angles, or trilateration) as the cursor, so it can be
  // anywhere on the board rather than only at nine hole centres.

  const GRID_COLUMNS = 3;
  // Horizontal pitch between neighbouring column centres, i.e. a column's width.
  const COLUMN_PITCH_CM = PLAY_WIDTH_CM / GRID_COLUMNS;

  // The fix as a cursor position, and whether x was actually resolved: from
  // both nodes, or from a scanner's servo angle. One node with no angle only
  // knows its own column, so its x is that column's centre.
  function worldFromFix(fix) {
    const scans = fix.scans || [];
    const sourceSlot = fix.source === "left" ? LEFT_SENSOR : fix.source === "right" ? RIGHT_SENSOR : null;
    const angled = sourceSlot !== null && scans[sourceSlot] && scans[sourceSlot].angle !== null;
    return { x: fix.xCm, y: fix.yCm, resolved: fix.source === "both" || Boolean(angled) };
  }

  // Position of the column a reading fell in, at that reading's depth. The
  // honest floor when there is no position to hold - and it is what the old
  // column-only code always assumed.
  function columnCentreWorld(column, distanceCm) {
    return { x: columnCentreCm(column), y: distanceCm, resolved: false };
  }

  // Continuous play-area centimetres -> canvas pixels.
  //
  // Calibrated so a position at a column centre AND a row-band centre lands on
  // that hole's centre exactly - the same pixel gridToCanvasPoint returns for
  // that cell. Every hole centre is therefore a fixed point of this mapping, so
  // the smooth cursor passes through all nine of them and the drawn cursor can
  // never disagree with the hit-test grid about where a mole is.
  //
  // Both axes are anchored on the NEAR-LEFT corner of the play area, because
  // that is the origin gridToCanvasPoint counts out from: x grows right from
  // the first column's centre, and depth grows up from the near edge, which is
  // canvas-down.
  function worldToCanvasPoint(canvas, xCm, yCm, column) {
    if (!Number.isFinite(xCm) || !Number.isFinite(yCm)) return null;

    const layout = window.getGameGridLayout(canvas);
    // Centre-to-centre spacing of neighbouring holes, in pixels.
    const pitch = layout.cellSize + layout.cellGap;

    // Rows come from the same column's calibrated near/far as gridToCanvasPoint
    // uses, so the two mappings stay in step even when columns are calibrated
    // to different depths.
    const bounds = window.getCalibrationBounds ? window.getCalibrationBounds() : null;
    const slot = Number.isInteger(column) && column >= 0 && column < GRID_COLUMNS ? column : 1;
    const span = bounds ? bounds.perColumn[slot] : { near: 20, far: 140 };
    const rowDepth = Math.max(1e-6, (span.far - span.near) / GRID_COLUMNS);

    // How many hole-widths from column 0's centre, and how far through the
    // three rows, measured from the near edge. A column centre is an integer,
    // and the middle of row r sits at t = r + 0.5.
    const acrossHoles = (xCm - columnCentreCm(0)) / COLUMN_PITCH_CM;
    const depthT = (yCm - span.near) / rowDepth;

    return {
      x: layout.gridLeft + layout.cellSize / 2 + acrossHoles * pitch,
      // Depth grows away from the screen, canvas y grows downward, so row 0
      // (nearest the screen) is the last pitch down.
      y: layout.gridTop + layout.cellSize / 2 + (GRID_COLUMNS - 0.5 - depthT) * pitch,
    };
  }

  // Drives the drawn cursor from a continuous position, through the spring.
  // Returns the pixel actually drawn, because the hover test has to use the
  // drawn position too - scoring against the raw target would whack a mole a
  // moment before the cursor visibly reached it.
  function moveCursor(canvas, world, column, dt) {
    const target = worldToCanvasPoint(canvas, world.x, world.y, column);
    if (!target) return null;
    const point = cursorSmoother.step(target, dt);
    if (!point) return null;
    gameState.cursor = { x: point.x, y: point.y, inBounds: true };
    return point;
  }

  // Last known-good cell, used to coast through brief signal loss.
  const sensorHold = { grid: null, world: null, lastOkAt: -Infinity };

  // --- Cell stabilisation ----------------------------------------------------

  const cellHistory = [];
  let stableCell = null;

  function resetCellFilter() {
    cellHistory.length = 0;
    stableCell = null;
  }

  // Returns the cell the cursor should actually sit in: the most frequent cell
  // across the recent window, which only changes once a rival has clearly won.
  function stabiliseCell(gx, gy, isNewReading) {
    // Render frames must not stuff the ballot box - only fresh readings vote.
    if (!isNewReading) return stableCell || { gx, gy };

    cellHistory.push(gx * 3 + gy);
    while (cellHistory.length > tuning.cellWindow) cellHistory.shift();

    const counts = new Map();
    let winner = cellHistory[0];
    let winnerVotes = 0;
    cellHistory.forEach((code) => {
      const votes = (counts.get(code) || 0) + 1;
      counts.set(code, votes);
      if (votes > winnerVotes) {
        winnerVotes = votes;
        winner = code;
      }
    });

    const candidate = { gx: Math.floor(winner / 3), gy: winner % 3 };

    // First lock-on adopts immediately so the cursor appears without delay.
    if (stableCell === null) {
      stableCell = candidate;
      return stableCell;
    }

    const unchanged = candidate.gx === stableCell.gx && candidate.gy === stableCell.gy;
    if (!unchanged && winnerVotes >= tuning.cellVotes) {
      stableCell = candidate;
    }
    return stableCell;
  }

  // Reads the sensors, maps the fix into grid space, and drives the cursor from
  // it. Hovering the active mole scores, exactly as the mouse does.
  function updateSensorCursor(canvas, orderedNodes) {
    const now = performance.now();
    const fix = readSensorCoordinate(orderedNodes);

    // Frame delta for the cursor spring. Clamped inside the smoother, and
    // meaningless on the first frame after a reset because the spring snaps to
    // its first target rather than easing toward it.
    const dt = cursorLastStepAt === null ? 0 : now - cursorLastStepAt;
    cursorLastStepAt = now;

    let grid = null;
    if (fix.status === "ok") {
      const mapped = window.rawToGrid(fix.column, fix.distanceCm, sensorHold.grid);
      if (mapped && mapped.inside) grid = mapped;
    }

    if (grid) {
      badReadingStreak = 0;
      // The cell the reading suggests is only a vote; the cursor follows the
      // consensus of the recent window.
      const cell = stabiliseCell(grid.gx, grid.gy, fix.isNewReading);
      const stable = { ...grid, gx: cell.gx, gy: cell.gy };

      // Two things come out of one set of readings: the discrete cell, which is
      // the game rule and is decided with the vote above, and the continuous
      // position, which is only ever used to draw the cursor. The column and row
      // are derived from that same position, so the cursor cannot drift
      // somewhere the grid mapping does not also believe the player is.
      const world = worldFromFix(fix);

      sensorHold.grid = { ...stable, yCm: world.y };
      sensorHold.world = world;
      sensorHold.lastOkAt = now;
      gameState.sensor = {
        ...fix, gx: stable.gx, gy: stable.gy,
        rawGx: grid.gx, rawGy: grid.gy,
        calibrated: grid.calibrated, held: false, heldFor: 0,
        xCm: world.x, yCm: world.y, resolved: world.resolved,
      };
      const point = moveCursor(canvas, world, cell.gx, dt);
      if (point) window.handleGameHover(canvas, point.x, point.y);
      return;
    }

    // Too close is a safety state: report it instantly, with no grace at all.
    if (fix.status === "too-close") {
      badReadingStreak = 0;
      sensorHold.grid = null;
      sensorHold.world = null;
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
    const withinBudget = badReadingStreak <= tuning.holdReadings;
    const withinTimeout = now - sensorHold.lastOkAt <= tuning.holdTimeoutMs;

    if (sensorHold.grid && withinBudget && withinTimeout) {
      const held = sensorHold.grid;
      // While held, the fix belongs to the BAD reading, so the last good
      // position is the one shown - exactly as the last good cell is.
      const world = sensorHold.world || columnCentreWorld(held.gx, held.yCm);
      gameState.sensor = {
        ...fix, status: "ok", gx: held.gx, gy: held.gy,
        calibrated: held.calibrated, held: true, heldFor: badReadingStreak,
        xCm: world.x, yCm: world.y, resolved: world.resolved,
      };
      // The spring keeps running while held, so the cursor eases to a stop
      // instead of freezing mid-board the moment a frame is dropped.
      const point = moveCursor(canvas, world, held.gx, dt);
      if (point) window.handleGameHover(canvas, point.x, point.y);
      return;
    }

    sensorHold.grid = null;
    sensorHold.world = null;
    gameState.sensor = {
      ...fix,
      status: fix.status === "ok" ? "out-of-bounds" : fix.status,
      gx: null, gy: null, held: false, heldFor: badReadingStreak,
    };
    gameState.cursor = { x: null, y: null, inBounds: false };
  }

  // --- Server-side coordinate (SERVER_FILTERING) -----------------------------
  // With the server's flag on, filterRules.py runs the whole chain once per
  // reading on the server and canvas.js hands each result over here. It takes
  // the place of updateSensorCursor() - conditioning, column, row, vote and
  // hold all happen on the server. With the flag off serverCoordinateActive
  // stays false and none of this runs. The JS copy above is still the rule
  // owner and is only deleted once the team drops the flag (README step 6).

  let serverCoordinateActive = false;
  let serverCoordinate = null;

  window.setServerFilteringActive = function setServerFilteringActive(active) {
    const next = Boolean(active);
    if (next === serverCoordinateActive) return;
    serverCoordinateActive = next;
    serverCoordinate = null;
    // Switching source mid-round must not carry the other path's state over.
    gameState.sensor = emptySensorState();
    resetSensorFilters();
  };

  // null means "no coordinate" (not assigned yet, or the socket dropped).
  window.setServerCoordinate = function setServerCoordinate(coordinate) {
    serverCoordinate = coordinate && typeof coordinate === "object" ? coordinate : null;
  };

  function listOrEmpty(values) {
    return Array.isArray(values) ? values : [null, null, null];
  }

  function numberOrNull(value) {
    return Number.isFinite(value) ? value : null;
  }

  // Server result (FilteredCoordinate.to_dict()) -> gameState.sensor, in the
  // same shape updateSensorCursor() produces, so the HUD, alert and logging
  // work unchanged.
  function applyServerCoordinate(canvas, orderedNodes) {
    // The server only recomputes when a reading arrives, so once every
    // assigned sensor is offline its last coordinate would sit on screen
    // forever. Treat that as no signal, which also pauses the round.
    const list = Array.isArray(orderedNodes) ? orderedNodes : [];
    const anyOnline = list.some((node) => node && node.online);
    const c = anyOnline ? serverCoordinate : null;

    if (!c) {
      gameState.sensor = emptySensorState();
      gameState.cursor = { x: null, y: null, inBounds: false };
      return;
    }

    const hasCell = c.status === "ok" && Number.isInteger(c.gx) && Number.isInteger(c.gy);
    const filtered = listOrEmpty(c.filtered);
    gameState.sensor = {
      // "ok" without a cell would let the round run with no cursor.
      status: c.status === "ok" && !hasCell ? "no-signal" : c.status,
      column: Number.isInteger(c.column) ? c.column : null,
      // y is the distance the fix used; for too-close it is the nearest RAW
      // reading, which the alert screen shows.
      distanceCm: numberOrNull(c.y),
      xCm: numberOrNull(c.x),
      yCm: numberOrNull(c.y),
      raw: listOrEmpty(c.raw),
      filtered,
      configured: filtered.filter((d) => d !== null && d !== undefined).length,
      gx: hasCell ? c.gx : null,
      gy: hasCell ? c.gy : null,
      rawGx: Number.isInteger(c.rawGx) ? c.rawGx : null,
      rawGy: Number.isInteger(c.rawGy) ? c.rawGy : null,
      calibrated: Boolean(c.calibrated),
      held: Boolean(c.held),
      heldFor: Number.isInteger(c.heldFor) ? c.heldFor : 0,
    };

    if (!hasCell) {
      gameState.cursor = { x: null, y: null, inBounds: false };
      return;
    }

    const point = window.gridToCanvasPoint(canvas, c.gx, c.gy);
    gameState.cursor = { x: point.x, y: point.y, inBounds: true };
    window.handleGameHover(canvas, point.x, point.y);
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
      // Continuous position in play-area centimetres, and whether x was actually
      // resolved - from both nodes, or from a scanner's angle - or fell back to
      // the column centre. A single node with no angle can never resolve x, and
      // this is how you tell that apart from a genuinely still player.
      world: sensor.xCm === null || sensor.xCm === undefined
        ? null
        : { xCm: sensor.xCm, yCm: sensor.yCm, resolved: Boolean(sensor.resolved) },
      cursor: gameState.cursor.x === null ? null : { ...gameState.cursor },
      badReadings: serverCoordinateActive ? sensor.heldFor || 0 : badReadingStreak,
      rejected: sensorFilters.map((filter) => filter.rejectCount),
      holdBudget: tuning.holdReadings,
      tuning: { ...tuning },
      rawCell: sensor.rawGx === undefined || sensor.rawGx === null
        ? null
        : { gx: sensor.rawGx, gy: sensor.rawGy },
      cellVotes: cellHistory.length,
      cellWindow: tuning.cellWindow,
      bounds: window.getCalibrationBounds ? window.getCalibrationBounds() : null,
      limits: {
        alertCm: window.getAlertThresholdCm ? window.getAlertThresholdCm() : window.ALERT_DISTANCE_CM,
        maxCm: maxCoordCm(),
        hardMaxCm: MAX_COORD_CM,
      },
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

  // Score + lives, right of the pause icon. The font sizes come with it
  // because the panel's height is built from them.
  function getScorePanelRect(canvas) {
    const width = canvas.clientWidth || canvas.width;
    const pauseLayout = getGamePauseLayout();
    const scoreFontSize = Math.max(22, Math.min(30, width * 0.024));
    const livesFontSize = Math.max(32, Math.min(46, width * 0.036));
    return {
      x: pauseLayout.x + pauseLayout.width + 10,
      y: pauseLayout.y,
      w: Math.max(190, Math.min(260, width * 0.2)),
      h: scoreFontSize + livesFontSize + 40,
      scoreFontSize,
      livesFontSize,
    };
  }

  // The How to Play legend, right-hand side: a header and three entries.
  const LEGEND_HEADER_H = 40;
  const LEGEND_ENTRY_H = 82;
  const LEGEND_ENTRIES = 3;

  function getLegendRect(canvas) {
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const w = Math.max(220, Math.min(300, width * 0.22));
    return {
      x: width - 12 - w,
      y: Math.max(140, height * 0.22),
      w,
      h: LEGEND_HEADER_H + LEGEND_ENTRIES * LEGEND_ENTRY_H + 14,
    };
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
  const SENSOR_ROWS = [
    { index: LEFT_SENSOR, label: "L", source: "left" },
    { index: RIGHT_SENSOR, label: "R", source: "right" },
  ];
  const SOURCE_LABELS = { both: "L+R", left: "L only", right: "R only" };
  // The scanner's state (src/scanning.cpp): both sensors agree, one sees the
  // player, or it is sweeping for them.
  const SCAN_STATE_NAMES = { 0: "found", 1: "half", 2: "lost" };
  const SCAN_STATE_COLOURS = { 0: "#22c55e", 1: "#f59e0b", 2: "#ef4444" };

  function formatCm(value) {
    return value === null || value === undefined ? "--" : value.toFixed(1);
  }

  // Was this sensor part of the fix? The browser path says which sensors the
  // trilateration used; the server path does not, so fall back to the column.
  function sensorUsed(sensor, row) {
    if (sensor.source) return sensor.source === "both" || sensor.source === row.source;
    return sensor.column === row.index;
  }

  function renderSensorPanel(ctx, x, y) {
    const sensor = gameState.sensor;

    const panelW = SENSOR_PANEL_W;
    const panelH = SENSOR_PANEL_H;
    const rowH = 20;

    drawHudPanel(ctx, x, y, panelW, panelH, 12);

    ctx.textAlign = "left";
    ctx.font = "bold 10.5px monospace";
    ctx.fillStyle = "#9298aa";
    ctx.fillText("NODE", x + 16, y + 20);
    ctx.fillText("RAW", x + 56, y + 20);
    ctx.fillText("FILT", x + 108, y + 20);
    ctx.fillText("L / R cm", x + 160, y + 20);
    ctx.fillText("SERVO", x + 226, y + 20);
    ctx.fillText("SCAN", x + 272, y + 20);
    ctx.fillText("USED", x + 322, y + 20);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 14, y + 27);
    ctx.lineTo(x + panelW - 14, y + 27);
    ctx.stroke();

    const raw = sensor.raw || [null, null, null];
    const filtered = sensor.filtered || [null, null, null];
    const scans = sensor.scans || [NO_SCAN, NO_SCAN, NO_SCAN];
    const echo = (cm) => (cm === null || cm < 0 ? "--" : cm.toFixed(0));

    SENSOR_ROWS.forEach((row, k) => {
      const i = row.index;
      const rowY = y + 27 + rowH * (k + 1);
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
      ctx.fillText(row.label, x + 33, rowY);

      ctx.font = "12px monospace";
      ctx.fillStyle = echoing ? "#cdd6f4" : "#63736f";
      ctx.fillText(formatCm(raw[i]), x + 56, rowY);

      ctx.fillStyle = live ? "#cdd6f4" : "#63736f";
      ctx.fillText(formatCm(filtered[i]), x + 108, rowY);

      // The scanner's own view: both ultrasonics, the servo angle the pair
      // was read at, and whether it has found the player.
      const scan = scans[i] || NO_SCAN;
      const heard = [scan.left, scan.right].filter((cm) => cm !== null && cm >= 0).length;
      ctx.fillStyle = heard === 2 ? "#cdd6f4" : heard === 1 ? "#f59e0b" : "#63736f";
      ctx.fillText(scan.left === null && scan.right === null ? "--" : `${echo(scan.left)}/${echo(scan.right)}`, x + 160, rowY);
      ctx.fillStyle = scan.angle === null ? "#63736f" : "#cdd6f4";
      ctx.fillText(scan.angle === null ? "--" : `${scan.angle.toFixed(0)}°`, x + 226, rowY);
      ctx.fillStyle = SCAN_STATE_COLOURS[scan.state] || "#63736f";
      ctx.fillText(SCAN_STATE_NAMES[scan.state] || "--", x + 272, rowY);

      if (sensorUsed(sensor, row)) {
        ctx.fillStyle = "#facc15";
        ctx.font = "bold 12px monospace";
        ctx.fillText("<--", x + 322, rowY);
      }
    });

    // The continuous position the cursor is drawn from, which nodes it came
    // from, and whether x was resolved (both nodes, or a scanner's angle) or
    // fell back to the column centre. With a single node and no angle x can
    // never be resolved, so this line is how you tell a coarse fix from a
    // genuinely still player.
    const posY = y + 27 + rowH * 3;
    ctx.font = "12px monospace";
    if (Number.isFinite(sensor.xCm) && Number.isFinite(sensor.yCm)) {
      const coarse = sensor.status === "ok" && sensor.resolved === false;
      ctx.fillStyle = coarse ? "#f59e0b" : "#cdd6f4";
      const from = SOURCE_LABELS[sensor.source] ? `  (${SOURCE_LABELS[sensor.source]})` : "";
      ctx.fillText(
        `x ${formatCm(sensor.xCm)}  y ${formatCm(sensor.yCm)} cm${from}${coarse ? "  column centre" : ""}`,
        x + 16,
        posY
      );
    } else {
      ctx.fillStyle = "#63736f";
      ctx.fillText("x --  y -- cm", x + 16, posY);
    }

    // Resolved fix
    const fixY = y + panelH - 12;
    const status = sensor.status;

    // Set here rather than inside each branch so the position line above cannot
    // leak its 11px font into the status text.
    ctx.font = "bold 12px monospace";

    if (status === "ok" && sensor.gx !== null) {
      ctx.fillStyle = sensor.held ? "#f59e0b" : "#22c55e";
      const disagrees =
        sensor.rawGx !== undefined && sensor.rawGx !== null &&
        (sensor.rawGx !== sensor.gx || sensor.rawGy !== sensor.gy);
      const label =
        `grid (${sensor.gx}, ${sensor.gy})  @ ${formatCm(sensor.distanceCm)}cm` +
        (disagrees ? `  [raw ${sensor.rawGx},${sensor.rawGy} outvoted]` : "");
      ctx.fillText(
        sensor.held ? `${label}  HELD ${sensor.heldFor}/${tuning.holdReadings}` : label,
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

  // --- Position map ----------------------------------------------------------
  // CoordinateMap (coordinateMap.js) takes a plain (x, y) in centimetres and
  // knows nothing about sensors. mapCoordinateFromSensor() is the only place
  // that translates today's fix into that form. Once filterRules.py sends the
  // filtered coordinate from the server, pass its x and y straight to
  // map.update() and delete mapCoordinateFromSensor().

  // Created on first use so load order against coordinateMap.js cannot bite.
  function getCoordinateMap() {
    if (!coordinateMap && window.CoordinateMap) {
      coordinateMap = new window.CoordinateMap({
        widthCm: MAP_AREA_WIDTH_CM,
        depthCm: maxCoordCm(),
      });
    }
    return coordinateMap;
  }

  function resetCoordinateMap() {
    lastMapPoint = null;
    if (coordinateMap) coordinateMap.clear();
  }

  // The continuous play-area position, which is the same fix the cursor is
  // drawn from, so the map and the cursor cannot disagree. While the cursor is
  // being held through bad readings the fix belongs to the bad reading, so the
  // last good position is shown instead.
  function mapCoordinateFromSensor(sensor) {
    const label = sensor.held ? "held"
      : sensor.status === "ok" ? null
      : String(sensor.status).replace(/-/g, " ");

    if (sensor.held) {
      return { x: lastMapPoint ? lastMapPoint.x : null,
               y: lastMapPoint ? lastMapPoint.y : null, label };
    }

    const hasFix = Number.isFinite(sensor.xCm) && Number.isFinite(sensor.yCm);
    if (!hasFix) return { x: null, y: null, label };

    // Out-of-bounds fixes still carry a position; the map pins those to its
    // edge in red, which shows the player which way they went.
    const point = { x: sensor.xCm, y: sensor.yCm };
    if (sensor.status === "ok") lastMapPoint = point;
    return { ...point, label };
  }

  // The server's coordinate already is a plain (x, y) in cm, and while held it
  // carries the last good position, so it passes straight through.
  function mapCoordinateFromServer(sensor) {
    const label = sensor.held ? "held"
      : sensor.status === "ok" ? null
      : String(sensor.status).replace(/-/g, " ");
    return { x: sensor.xCm, y: sensor.yCm, label };
  }

  // Drawn with its bottom edge at `bottom`, never reaching above `minTop`.
  // Returns the map's top edge, or `bottom` when there is no room for even the
  // smallest legible map.
  function renderCoordinateMap(ctx, canvas, bottom, minTop) {
    const map = getCoordinateMap();
    if (!map) return bottom;

    // Fit the gutter left of the board, and the room above the sensor panel.
    const gutter = window.getGameGridLayout(canvas).gridLeft;
    map.size = Math.max(MAP_MIN_SIZE, Math.min(MAP_MAX_SIZE, gutter - 48));
    const chrome = map.height - map.size;
    map.size = Math.min(map.size, bottom - minTop - chrome);
    if (map.size < MAP_MIN_SIZE) return bottom;
    map.depthCm = maxCoordCm();

    // Draw the SAME row boundaries rawToGrid() uses, and highlight the cell the
    // game actually settled on. Letting the map derive its own cell from x and
    // y made it disagree with the board near row edges, where hysteresis holds.
    const bounds = window.getCalibrationBounds ? window.getCalibrationBounds() : null;
    map.setColumns(bounds ? bounds.perColumn : null);

    const sensor = gameState.sensor;
    const { x, y, label } = serverCoordinateActive
      ? mapCoordinateFromServer(sensor)
      : mapCoordinateFromSensor(sensor);
    const cell = Number.isInteger(sensor.gx) && Number.isInteger(sensor.gy)
      ? { gx: sensor.gx, gy: sensor.gy } : null;
    map.update(x, y, label, cell);

    const top = bottom - map.height;
    map.render(ctx, HUD_EDGE, top);
    return top;
  }

  // --- Miniature cursor ------------------------------------------------------
  // A small copy of the board in the bottom-left corner with the LIVE cursor on
  // it. In sensor mode that is the trilaterated position before the cell vote,
  // so it moves continuously while the big cursor snaps from cell to cell.

  let lastMiniPoint = null;

  function miniCursorView(canvas) {
    const layout = window.getGameGridLayout(canvas);
    const view = {
      point: null,
      inBounds: true,
      cell: null,
      activeHole: gameState.activeHole,
      activeType: gameState.moleType,
      footer: "",
      label: null,
    };

    if (gameState.inputMode === "sensor") {
      const sensor = gameState.sensor;
      if (Number.isInteger(sensor.gx) && Number.isInteger(sensor.gy)) view.cell = holeForCell(sensor.gx, sensor.gy);
      view.label = sensor.held ? "HELD" : null;

      const live = !sensor.held && Number.isFinite(sensor.xCm) && Number.isFinite(sensor.yCm);
      if (live) {
        // Depth as a share of this column's calibrated play depth, the screen
        // edge at the bottom - the same rows rawToGrid() uses.
        const bounds = window.getCalibrationBounds ? window.getCalibrationBounds() : null;
        const span = bounds && bounds.perColumn
          ? bounds.perColumn[columnAtCm(sensor.xCm)]
          : { near: 0, far: maxCoordCm() };
        const up = (sensor.yCm - span.near) / (span.far - span.near);
        const point = {
          fx: sensor.xCm / PLAY_WIDTH_CM,
          fy: 1 - up,
          inBounds: sensor.status === "ok" && up >= 0 && up <= 1,
          footer: `x ${sensor.xCm.toFixed(0)}  y ${sensor.yCm.toFixed(0)} cm`,
        };
        if (sensor.status === "ok") lastMiniPoint = point;
        view.point = { fx: point.fx, fy: point.fy };
        view.inBounds = point.inBounds;
        view.footer = point.footer;
      } else if (sensor.held && lastMiniPoint) {
        view.point = { fx: lastMiniPoint.fx, fy: lastMiniPoint.fy };
        view.footer = lastMiniPoint.footer;
      } else {
        view.footer = String(sensor.status).replace(/-/g, " ");
      }
      return view;
    }

    if (gameState.cursor.x === null) {
      view.footer = gameState.inputMode === "remote" ? "no finger on the pad" : "move the mouse";
      return view;
    }
    const fx = (gameState.cursor.x - layout.gridLeft) / layout.gridSize;
    const fy = (gameState.cursor.y - layout.gridTop) / layout.gridSize;
    const hole = holeAtPoint(layout, gameState.cursor.x, gameState.cursor.y);
    view.point = { fx, fy };
    view.inBounds = fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1;
    view.cell = hole ? hole.index : null;
    if (hole) view.footer = `hole ${hole.index + 1}`;
    else view.footer = view.inBounds ? "between holes" : "off the board";
    return view;
  }

  // --- Stats toggle ----------------------------------------------------------
  // Top-right, under the level panel: shows or hides the three stats panels
  // (LIVE STATS, CURSOR, LIVE DATA). Remembered per browser; the game plays the
  // same either way.
  const STATS_VISIBLE_KEY = "eng3000.statsVisible";
  let statsVisible = true;
  try {
    statsVisible = localStorage.getItem(STATS_VISIBLE_KEY) !== "0";
  } catch (err) {
    // Storage blocked: start with the stats shown.
  }

  function getStatsToggleLayout(canvas) {
    const width = canvas.clientWidth || canvas.width;
    const w = 130; // the level panel's width, so the two line up
    return { x: width - 12 - w, y: 60, width: w, height: 32 };
  }

  window.getStatsToggleAtPoint = function getStatsToggleAtPoint(canvas, x, y) {
    return pointInRect(x, y, getStatsToggleLayout(canvas)) ? { type: "stats" } : null;
  };

  window.toggleGameStats = function toggleGameStats() {
    statsVisible = !statsVisible;
    try {
      localStorage.setItem(STATS_VISIBLE_KEY, statsVisible ? "1" : "0");
    } catch (err) {
      // Not remembered, but still toggled for this page.
    }
    return statsVisible;
  };

  function drawStatsToggle(ctx, canvas) {
    const r = getStatsToggleLayout(canvas);
    drawHudPanel(ctx, r.x, r.y, r.width, r.height, 10);
    ctx.textAlign = "center";
    ctx.fillStyle = statsVisible ? "#f4f4f5" : "#9298aa";
    ctx.font = "bold 14px monospace";
    ctx.fillText(statsVisible ? "Stats: On" : "Stats: Off", r.x + r.width / 2, r.y + r.height / 2 + 5);
    ctx.textAlign = "left";
  }

  // --- HUD layout ------------------------------------------------------------
  // Bottom-left, from the corner up: the miniature cursor; in sensor mode the
  // sensor panel on it and the position map on that (mouse and remote need no
  // input box). LIVE STATS fills the room
  // left between that stack and the score panel, showing as many rows as fit.
  // LIVE DATA (box plot and bar charts) sits under the How to Play legend.

  function renderHud(ctx, canvas) {
    const height = canvas.clientHeight || canvas.height;
    const view = window.GameStatsView || null;
    const miniSize = view ? view.MINI_CURSOR : { w: 150, h: 180 };
    const mini = { x: HUD_EDGE, y: height - HUD_EDGE - miniSize.h, w: miniSize.w, h: miniSize.h };
    if (view && statsVisible) view.renderMiniCursor(ctx, mini, miniCursorView(canvas));

    const score = getScorePanelRect(canvas);
    const minTop = score.y + score.h + HUD_GAP;
    let stackTop = mini.y;

    if (gameState.inputMode === "sensor") {
      stackTop -= HUD_GAP + SENSOR_PANEL_H;
      renderSensorPanel(ctx, HUD_EDGE, stackTop);
      stackTop = renderCoordinateMap(ctx, canvas, stackTop - MAP_GAP, minTop);
    }

    const stats = roundStats();
    if (!view || !stats || !statsVisible) return;
    const now = performance.now();
    const snap = stats.snapshot(now);

    const gutter = window.getGameGridLayout(canvas).gridLeft - HUD_EDGE * 2;
    const statsRect = { x: HUD_EDGE, y: minTop, w: Math.min(STATS_PANEL_W, gutter), h: stackTop - HUD_GAP - minTop };
    if (statsRect.w >= STATS_PANEL_MIN_W && statsRect.h >= view.statsHeight(3)) {
      view.renderStats(ctx, statsRect, snap);
    }

    const legend = getLegendRect(canvas);
    const chartsTop = legend.y + legend.h + HUD_GAP;
    const chartsRect = {
      x: legend.x, y: chartsTop, w: legend.w,
      h: Math.min(CHARTS_PANEL_MAX_H, height - HUD_EDGE - chartsTop),
    };
    if (chartsRect.h >= view.CHARTS_MIN_H) {
      const bounds = window.getCalibrationBounds ? window.getCalibrationBounds() : null;
      const band = bounds ? { from: bounds.nearCm, to: bounds.farCm } : null;
      view.renderCharts(ctx, chartsRect, snap, now, band);
    }
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
    const scorePanel = getScorePanelRect(canvas);
    const { scoreFontSize, livesFontSize } = scorePanel;
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
    drawStatsToggle(ctx, canvas);

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
    const legendRect = getLegendRect(canvas);
    const legendWidth = legendRect.w;
    const legendX = legendRect.x;
    const legendY = legendRect.y;
    const legendEntries = [
      { imgKey: "mole", color: "#8b5e3c", title: "Mole", lines: ["Whack it for", "+1 point."] },
      { imgKey: "super_mole", color: "#eab308", title: "Hat Mole", lines: ["2 hits to defeat,", `worth +${SUPER_MOLE_POINTS} points.`] },
      { imgKey: "bomb", color: "#ef4444", title: "Bomb", lines: [`Avoid! -${BOMB_PENALTY} points`, "and a lost life."] },
    ];
    const legendEntryHeight = LEGEND_ENTRY_H;
    const legendHeaderHeight = LEGEND_HEADER_H;
    drawHudPanel(ctx, legendX, legendY, legendWidth, legendRect.h, 14);

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

    renderHud(ctx, canvas);

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
