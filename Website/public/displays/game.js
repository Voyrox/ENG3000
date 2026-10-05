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
//   window.getGameCursorStatus(canvas)          - the cursor and sensor (x, y) for the phone panel
//   window.setServerFilteringActive(active)     - the server has SERVER_FILTERING on
//   window.setServerCoordinate(coordinate)      - latest filtered coordinate from the server
//   window.setRemotePoint(nx, ny) / window.releaseRemotePoint() - the phone pad's override
//
// Two input modes share all of the game logic. Only the cursor source differs:
//   "mouse"  - canvas.js feeds raw canvas pixels straight from mousemove.
//              Reached via Skip on the calibration screen.
//   "sensor" - readSensorCoordinate() places the player from the LEFT and
//              RIGHT scanner nodes (distance + servo angle; trilateration for
//              nodes that send no angle) as ONE continuous position in
//              centimetres, and rawToGrid() (callibrate_corners.js) turns that
//              into 0-2 grid coordinates, gy 0 being the row nearest the
//              screen - drawn at the TOP of the board (boardRow()). That cell,
//              after the majority vote, is the game rule: it decides which
//              mole is live. The continuous position is drawn as the cursor
//              through the spring in positionSolver.js, so the player glides
//              between holes instead of snapping to their centres. Entered
//              with Start Game once both nodes are identified.
//              When the server runs filterRules.py (SERVER_FILTERING on), its
//              coordinate replaces readSensorCoordinate() for the cursor and
//              alert; with the flag off (the default) nothing here changes.
//
// The phone pad is not a mode but an override on top of either: while a
// finger is on the control panel's pad (/control, only served when the server
// runs with CON=1) the cursor eases towards the finger and scores, and lifting
// it hands the cursor straight back. Nothing else changes (Aaron, 5 Oct): the
// sensors keep running underneath, so the sensor panel, the live stats and
// charts carry on, but they cannot hold the round or raise an alert while the
// phone places the player.

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
  // Hard ceiling before any calibration exists, and the deepest a calibration
  // corner can be captured at (SENSOR_LIMITS.maxCm). The nodes hear out to
  // src/Config.h's MAX_TARGET_CM, 190 cm, and a capture is the depth to the
  // middle of the player, tuning.bodyRadiusCm (15) further out. At 150 a
  // player standing on a far edge 160 cm out could not be captured, so the far
  // edge could never be set past 150. filterRules.py PlayArea.ABSOLUTE_MAX_CM.
  const MAX_COORD_CM = 205;

  // Once the play area is calibrated, the far edge sets the depth limit
  // reported by getSensorDebug() rather than this blanket one.
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

  // Smoothing after the median. Each channel runs median -> Kalman -> FFT
  // low-pass (conditionSensor()); the numbers that can be tuned live are in
  // `tuning` below.
  //
  // Kalman: a constant-velocity filter on the median's output - the same model
  // and noise levels as ConstantVelocityTracker in tracking.py, which the
  // Python copy of this chain (filterRules.py) uses directly. Its velocity
  // state follows a walking player without the lag an average adds.
  const KALMAN_GAP_RESET_S = 0.5;     // tracking.py DEFAULT_GAP_RESET_S
  const KALMAN_V0_SIGMA_CM_S = 100;   // tracking.py DEFAULT_V0_SIGMA_CM_S
  // FFT low-pass: the last fftWindow Kalman outputs, with their straight-line
  // trend taken out and the window mirrored at its newest end, are cut above
  // fftCutoffHz and the newest sample is read back (fftLowpassLast()). The
  // trend and the mirror stop the transform treating the window as a loop:
  // with only the mean taken out, a player walking at 50 cm/s read about 35 cm
  // behind where they were. The sample rate is measured from the window's own
  // timestamps: a node sends about 11-12 readings a second while it has its
  // turn, fewer with multi-pulse on, so a fixed rate would put the cutoff
  // somewhere else. A window never spans the other node's turn - the channel
  // starts again after a silence (conditionSensor()).
  const FFT_MIN_SAMPLES = 8;          // fewer and the Kalman output passes straight through

  // --- Live-tunable smoothing -----------------------------------------------
  // The server broadcasts on every node message, so with two sensors at 20Hz
  // roughly 40 readings arrive each second. The window sizes below are counted
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
    // Neither node has sent a new reading for this long (ms), or the server
    // says both are offline: the game says Sensors offline and the round
    // waits. Unusable readings are otherwise ridden out on the last good
    // square for as long as they last (updateSensorCursor()).
    offlineMs: 5000,
    // The Kalman switch (the control panel's Kalman button, setKalman();
    // Aaron, 5 Oct). false turns off both Kalman filters: each sensor's
    // distance goes median -> FFT (conditionSensor()), and line of sight
    // places the player at each new reading's own point, with no gate and
    // nothing kept from the readings before (stepLosTrack()). The servos never
    // see it: the nodes steer on their own readings. Python: FilterConfig
    // kalman.
    kalman: true,
    // The smoothing after each sensor's median (see conditionSensor()).
    // kalmanSigmaA: the player's acceleration noise, cm/s^2 - higher follows a
    // lunge faster, lower smooths more. kalmanSigmaR: one reading's noise, cm.
    // fftWindow: Kalman outputs in the FFT window; 0 turns the FFT stage off.
    // fftCutoffHz: the FFT low-pass keeps what is at or below this.
    // Changes apply from the next reading; the Python copy of this chain
    // (filterRules.FilterConfig) has the same defaults.
    kalmanSigmaA: 400,
    kalmanSigmaR: 0.91,
    fftWindow: 32,
    fftCutoffHz: 3,
    // The line-of-sight tracker (see stepLosTrack()). losAccelCmS2: how hard
    // the player can change pace - higher follows a dash faster, lower keeps
    // what the other node saw on its last turn for longer. losBearing*Deg:
    // how far off its aim a node may be when both of its sensors see the
    // player (found), one does (half-found), or it does not say. Python:
    // FilterConfig los_*.
    losAccelCmS2: 150,
    losBearingFoundDeg: 4,
    losBearingHalfDeg: 15,
    losBearingUnknownDeg: 7,
    // Trilateration's beam check (see inBeam()): a crossing of the two
    // distance circles counts only if it lies within this many degrees of
    // where each node's servo points, widened by bodyHalfWidthCm either side.
    // The sensors' beam is under 15 degrees wide, 7.5 either side. Python:
    // FilterConfig tri_beam_half_deg.
    triBeamHalfDeg: 7.5,
    // The player is a body, not a point (see bodyCentreCm()). bodyRadiusCm:
    // an echo comes back off the side of the player nearest the node, so each
    // distance falls this far short of the middle of them; it is added back
    // before the player is placed. bodyHalfWidthCm: a node's servo stops
    // wherever its beam finds the player, anywhere across their body, so its
    // aim can be this far either side of their middle whatever the distance;
    // the line of sight and the beam check allow for it. Measured on the rig
    // (centre test, 4 Oct): the readings fell 13-37 cm short of the taped
    // spots. Python: FilterConfig body_radius_cm, body_half_width_cm.
    bodyRadiusCm: 15,
    bodyHalfWidthCm: 20,
    // Dynamic, the default position method (see dynamicLeader()): a method
    // that has kept the player in one square this long counts as fully
    // steady, and past that line of sight wins, then trilateration, then the
    // average. Python: FilterConfig dynamic_steady_ms.
    dynamicSteadyMs: 1000,
    // Dynamic's two rules, checked before the steadiest method (see
    // dynamicRule(); Aaron, 5 Oct). centreSeenMs: the centre rule crosses each
    // node's servo line from its last reading that found or half-found the
    // player, if both are this recent (ms). centreHoldMs: once the lines have
    // crossed in the centre column, the player stays in it this long (ms)
    // while both lines are recent, even if the crossing strays outside.
    // confidentReadings, confidentMs: a node is confident when this many of
    // its readings in a row found the player (both heads), the latest this
    // recent, and its own reading is inside the play area; a lone confident
    // node places the player by itself. Python: FilterConfig centre_seen_ms,
    // centre_hold_ms, confident_readings, confident_ms.
    centreSeenMs: 1500,
    centreHoldMs: 1000,
    confidentReadings: 2,
    confidentMs: 1500,
    // sideLockDepthCm: the side-column lock needs the servo lines to cross at
    // least this far inside the left or right column. columnLock, loneNode,
    // cornerNode: Dynamic's rules on or off - the column lock (centre and
    // sides), a lone confident node, and the near node alone in its far
    // corner (A1, A3) - set from the control panel (setDynamicRules()) and
    // kept in this browser. Python: FilterConfig side_lock_depth_cm,
    // column_lock, lone_node, corner_node.
    sideLockDepthCm: 20,
    columnLock: true,
    loneNode: true,
    cornerNode: true,
    // Out of bounds, the only time the game says it (Aaron, 5 Oct): both
    // nodes are lost. A node is lost when its last lostReadings readings,
    // scored found +1, half 0, lost -1 (as the control panel shows each
    // reading), add up to 0 or less, so the odd found reading among lost ones
    // does not stop it. Until a node has had lostReadings readings in the
    // round it is not lost, so it is always sustained. Set from the control
    // panel (setLostReadings()), kept in this browser. See bothNodesLost().
    // Python: FilterConfig lost_readings.
    lostReadings: 8,
  };

  // The most readings a node's lost score can be taken over (setLostReadings()).
  const LOST_READINGS_MAX = 50;
  const LOST_READINGS_KEY = "eng3000.lostReadings";

  // How many readings a node's lost score is taken over: from the control
  // panel (canvas.js, "lostReadings"), clamped to 1..LOST_READINGS_MAX and
  // kept in this browser, so a reload keeps it. Returns the value in use.
  window.setLostReadings = function setLostReadings(count) {
    const n = Math.round(Number(count));
    if (Number.isFinite(n)) {
      tuning.lostReadings = Math.max(1, Math.min(LOST_READINGS_MAX, n));
      try {
        window.localStorage.setItem(LOST_READINGS_KEY, String(tuning.lostReadings));
      } catch (err) {
        // No storage (a private window, the tests): it lasts until a reload.
      }
    }
    return tuning.lostReadings;
  };

  window.getLostReadings = function getLostReadings() {
    return tuning.lostReadings;
  };

  try {
    const saved = window.localStorage && window.localStorage.getItem(LOST_READINGS_KEY);
    if (saved !== null && saved !== undefined) window.setLostReadings(saved);
  } catch (err) {
    // As above: the default stands.
  }

  // Dynamic's rules on or off, { columnLock, loneNode, cornerNode } (see
  // dynamicRule()). From the control panel (canvas.js, "dynamicRules"); only
  // the switches named change. Kept in this browser like lostReadings.
  const DYNAMIC_RULE_SWITCHES = ["columnLock", "loneNode", "cornerNode"];
  const DYNAMIC_RULES_KEY = "eng3000.dynamicRules";

  window.getDynamicRules = function getDynamicRules() {
    return Object.fromEntries(DYNAMIC_RULE_SWITCHES.map((name) => [name, tuning[name]]));
  };

  window.setDynamicRules = function setDynamicRules(rules) {
    if (rules && typeof rules === "object") {
      DYNAMIC_RULE_SWITCHES.forEach((name) => {
        if (typeof rules[name] === "boolean") tuning[name] = rules[name];
      });
      try {
        window.localStorage.setItem(DYNAMIC_RULES_KEY, JSON.stringify(window.getDynamicRules()));
      } catch (err) {
        // No storage (private window, tests): the switches hold until reload.
      }
    }
    return window.getDynamicRules();
  };

  try {
    const saved = window.localStorage && window.localStorage.getItem(DYNAMIC_RULES_KEY);
    if (saved) window.setDynamicRules(JSON.parse(saved));
  } catch (err) {
    // A missing or unreadable setting: every rule stays on.
  }

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

  // HUD layout (see renderHud()). Bottom-left: the sensor panel (sensor mode
  // only), with LIVE STATS above it.
  const HUD_EDGE = 12;            // px from the canvas edge
  const HUD_GAP = 10;             // px between stacked panels
  const SENSOR_PANEL_W = 380;     // px
  const SENSOR_PANEL_H = 150;     // px
  const STATS_PANEL_W = 270;      // px; LIVE STATS, left gutter
  const STATS_PANEL_MIN_W = 190;  // px; narrower and the values collide with the labels
  const CHARTS_PANEL_MAX_H = 300; // px; LIVE DATA, under the legend

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
    // Multi-pulse, switched with the Pulses button on the game screen: in found
    // or half-found the scanner nodes take this many pulse pairs at one angle
    // and average them before moving. 1 is off. canvas.js passes it on to the
    // server (nodes:pulses), which tells the nodes (PULSES <n>).
    pulsesPerAngle: 1,
  };

  // The Pulses button steps through these: off, 2, 3.
  const PULSE_COUNT_OPTIONS = [1, 2, 3];

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
    status: "no-signal", // "ok" | "too-close" | "no-signal" | "out-of-bounds" | "offline"
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
    inputMode: "mouse", // "mouse" | "sensor"
    remoteActive: false, // a finger on the phone pad has the cursor, in either mode
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

  // The cursor each mode would draw without the phone pad: the sensors'
  // (updateGame()) and the mouse's, kept while a finger has the drawn one.
  let sensorCursor = { x: null, y: null, inBounds: true };
  let mouseCursor = { x: null, y: null, inBounds: true };

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
    sensorCursor = { x: null, y: null, inBounds: true };
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
    // "remote" was a mode before the pad became an override; a /control page
    // from then still asks for it, and gets the sensors with the pad on top.
    gameState.inputMode = mode === "sensor" || mode === "remote" ? "sensor" : "mouse";
    // Drop any stale cursor so the modes never inherit each other's position.
    gameState.cursor = { x: null, y: null, inBounds: true };
    sensorCursor = { x: null, y: null, inBounds: true };
    mouseCursor = { x: null, y: null, inBounds: true };
    clearRemote();
    gameState.sensor = emptySensorState();
    resetSensorFilters();
  };

  window.getGameInputMode = function getGameInputMode() {
    return gameState.inputMode;
  };

  // The full-screen alert is driven purely by the raw distance, and only in
  // sensor mode mid-round - the mouse has no notion of standing too close, and
  // a paused or finished round should not be hijacked. Nor while the phone pad
  // places the player.
  window.isGameAlertActive = function isGameAlertActive() {
    return (
      gameState.inputMode === "sensor" &&
      !gameState.remoteActive &&
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
    updateRoomStatus(orderedNodes);
    if (gameState.inputMode === "sensor" && canvas) {
      // The sensors move their own cursor, even while the phone pad has the
      // one drawn, so lifting the finger hands back a cursor that kept up.
      gameState.cursor = { ...sensorCursor };
      if (serverCoordinateActive) {
        applyServerCoordinate(canvas, orderedNodes);
      } else {
        updateSensorCursor(canvas, orderedNodes);
      }
      sensorCursor = { ...gameState.cursor };
      recordSensorReading(now, orderedNodes);
    }
    // The phone pad, on top of either mode: its cursor replaces the one above.
    if (gameState.remoteActive && canvas) {
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

  // Grid cell (gx, gy; gy 0 = the row nearest the screen) -> hole index
  // (0 top-left, reading order).
  function holeForCell(gx, gy) {
    return boardRow(gy) * 3 + gx;
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
  // movement cannot fight the sensors for control of the cursor, and only
  // remembered while the phone pad has it.
  window.setGameCursor = function setGameCursor(canvas, x, y) {
    if (gameState.inputMode !== "mouse") return;
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    mouseCursor = { x, y, inBounds: x >= 0 && x <= width && y >= 0 && y <= height };
    if (!gameState.remoteActive) gameState.cursor = { ...mouseCursor };
  };

  // The phone pad: the finger's position, normalised to 0-1 with (0,0) at the
  // top-left, same orientation as the on-screen grid. The first point takes
  // the cursor over from whichever mode is running; anything non-numeric
  // lets go of it, as lifting the finger does.
  window.setRemotePoint = function setRemotePoint(nx, ny) {
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
      window.releaseRemotePoint();
      return;
    }
    const clamp = (v) => Math.min(1, Math.max(0, v));
    gameState.remoteActive = true;
    gameState.remoteTarget = { nx: clamp(nx), ny: clamp(ny) };
  };

  // The finger lifted: the mode's own cursor is drawn again straight away.
  window.releaseRemotePoint = function releaseRemotePoint() {
    if (!gameState.remoteActive) return;
    clearRemote();
    gameState.cursor = { ...(gameState.inputMode === "sensor" ? sensorCursor : mouseCursor) };
  };

  window.isRemoteActive = function isRemoteActive() {
    return gameState.remoteActive;
  };

  function clearRemote() {
    gameState.remoteActive = false;
    gameState.remoteTarget = null;
    gameState.remotePos = null;
    gameState.remoteLastFrame = null;
    gameState.remoteHole = -1;
  }

  // Stored normalised rather than as pixels, so a resize keeps the cursor on
  // the same spot of the grid. Hovering scores, exactly as in sensor mode (and
  // the sensors' own cursor does not, see hoverFromSensors()).
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

  // A cursor as a fraction of the board - 0-1 with (0,0) at the top-left, the
  // pad's own orientation - and the hole under it, or null and -1.
  function cursorOnBoard(canvas, cursor) {
    if (!canvas || cursor.x === null) return { board: null, hole: -1 };
    const layout = window.getGameGridLayout(canvas);
    const over = holeAtPoint(layout, cursor.x, cursor.y);
    return {
      board: {
        nx: (cursor.x - layout.gridLeft) / layout.gridSize,
        ny: (cursor.y - layout.gridTop) / layout.gridSize,
      },
      hole: over ? over.index : -1,
    };
  }

  // The cursor as the phone control panel mirrors it, in any input mode.
  // board is the drawn cursor (cursorOnBoard()) and hole the hole under it,
  // which is the one that scores; remote says the phone pad has it. sensor is
  // only filled in sensor mode, and carries on while the pad has the cursor:
  // the player's position in play-area cm (x across from screen-left, y the
  // depth from the screen), the cell, the state the sensors are in, and board,
  // the sensors' own cursor.
  window.getGameCursorStatus = function getGameCursorStatus(canvas) {
    const { board, hole } = cursorOnBoard(canvas, gameState.cursor);
    const remote = gameState.remoteActive;

    if (gameState.inputMode !== "sensor") return { board, hole, remote, sensor: null };

    const sensor = gameState.sensor;
    const hasCell = Number.isInteger(sensor.gx) && Number.isInteger(sensor.gy);
    return {
      board,
      hole,
      remote,
      sensor: {
        board: cursorOnBoard(canvas, sensorCursor).board,
        status: sensor.status,
        held: Boolean(sensor.held),
        source: sensor.source || null,
        xCm: numberOrNull(sensor.xCm),
        yCm: numberOrNull(sensor.yCm),
        distanceCm: numberOrNull(sensor.distanceCm),
        gx: hasCell ? sensor.gx : null,
        gy: hasCell ? sensor.gy : null,
        method: positioning.method,
        placedBy: sensor.placedBy || null,
        // Compare's rings, on the control panel's pad: only while Compare is
        // on and the browser places the player itself (the server's
        // coordinate carries no fixes).
        compare: positioning.compare && !serverCoordinateActive,
        fixes: compareFixes(canvas, sensor.fixes),
      },
    };
  };

  // Every method's position as Compare's rings show it: { dyn, los, tri, avg }, each
  // { xCm, yCm, nx, ny } or null. xCm and yCm are as the method placed the
  // player; nx and ny are its ring on the board, as fractions like board above
  // (x clamped to the board first, as the ring is).
  function compareFixes(canvas, fixes) {
    const out = {};
    POSITION_METHODS.forEach((method) => {
      const fix = fixes && fixes[method];
      if (!fix || !Number.isFinite(fix.x) || !Number.isFinite(fix.y)) {
        out[method] = null;
        return;
      }
      let nx = null;
      let ny = null;
      if (canvas) {
        const x = Math.max(0, Math.min(PLAY_WIDTH_CM, fix.x));
        const point = worldToCanvasPoint(canvas, x, fix.y, columnAtCm(x));
        if (point) {
          const layout = window.getGameGridLayout(canvas);
          nx = (point.x - layout.gridLeft) / layout.gridSize;
          ny = (point.y - layout.gridTop) / layout.gridSize;
        }
      }
      out[method] = { xCm: fix.x, yCm: fix.y, nx, ny };
    });
    return out;
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
  // angle the reading was taken at (90 = straight out, more = screen-right),
  // the scan state (0 found, 1 half-found, 2 lost), both ultrasonics
  // (-1 = no echo) and the empty room (0 not learnt, 1 learning, 2 learnt; see
  // src/RoomMap.h). Each is null when the node's firmware does not send it.
  const NO_SCAN = { angle: null, state: null, left: null, right: null, room: null };

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
      room: numberOrNull(payload.room),
    };
  }

  window.readNodeScan = readScan;

  // The empty room across the scanner nodes, from their latest readings:
  // "learning" while any node is, "learned" once every node reporting it has,
  // "not-learned" otherwise, and null when no node's firmware reports it.
  const ROOM_LEARNING = 1;
  const ROOM_LEARNED = 2;
  let roomStatus = null;

  function readRoomStatus(orderedNodes) {
    const rooms = (Array.isArray(orderedNodes) ? orderedNodes : [])
      .map((node) => readScan(node).room)
      .filter((room) => room !== null);
    if (rooms.length === 0) return null;
    if (rooms.includes(ROOM_LEARNING)) return "learning";
    return rooms.every((room) => room === ROOM_LEARNED) ? "learned" : "not-learned";
  }

  window.getGameRoomStatus = () => roomStatus;

  // A press shows as learning straight away: the nodes' first learning reading
  // takes a second or two to arrive, and a second press would start the sweep
  // over. Once a node reports learning, its readings take over.
  const ROOM_REQUEST_GRACE_MS = 5000;
  let roomRequestedAt = -Infinity;

  window.noteGameRoomRequested = function noteGameRoomRequested() {
    roomRequestedAt = performance.now();
    roomStatus = "learning";
  };

  function updateRoomStatus(orderedNodes) {
    roomStatus = readRoomStatus(orderedNodes);
    if (roomStatus === "learning") {
      roomRequestedAt = -Infinity;
    } else if (performance.now() - roomRequestedAt < ROOM_REQUEST_GRACE_MS) {
      roomStatus = "learning";
    }
  }

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
      kalman: makeKalman(),
      smoothed: [],     // recent Kalman outputs: the FFT stage's window
      smoothedAt: [],   // ms each of those was taken at
      steppedAt: -Infinity, // ms of the last reading (or dropout) through this channel
      angle: null,      // bearing of the current distance track
    };
  }

  // The whole channel starts again from the next reading: nothing it
  // remembers - the windows, the Kalman, the gate's anchor - still describes
  // where the player is.
  function restartChannel(filter) {
    restartSmoothing(filter);
    filter.value = null;
    filter.lastGoodAt = -Infinity;
    filter.anchor = null;
    filter.anchorAt = -Infinity;
    filter.rejects.length = 0;
  }

  // The median onwards starts again from the next reading. After a re-lock, or
  // once the hold has run out, the old track says nothing about the new one.
  function restartSmoothing(filter) {
    filter.samples.length = 0;
    resetKalman(filter.kalman);
    filter.smoothed.length = 0;
    filter.smoothedAt.length = 0;
  }

  // --- Kalman stage ----------------------------------------------------------
  // Port of ConstantVelocityTracker.update() in tracking.py, operation for
  // operation, so filterRules.py reproduces it exactly. State [d, v] in cm and
  // cm/s, covariance [[p00, p01], [p01, p11]], times in seconds.

  function makeKalman() {
    return { d: null, v: 0, p00: 0, p01: 0, p11: 0, t: null, tReading: null };
  }

  function resetKalman(k) {
    k.d = null;
    k.v = 0;
    k.p00 = k.p01 = k.p11 = 0;
    k.t = null;
    k.tReading = null;
  }

  function kalmanUpdate(k, z, t) {
    const sigmaA = tuning.kalmanSigmaA;
    const sigmaR = tuning.kalmanSigmaR;
    if (k.d !== null && t - k.tReading > KALMAN_GAP_RESET_S) resetKalman(k);

    if (k.d === null) {
      k.d = z;
      k.v = 0;
      k.p00 = sigmaR ** 2;
      k.p01 = 0;
      k.p11 = KALMAN_V0_SIGMA_CM_S ** 2;
      k.t = t;
      k.tReading = t;
      return k.d;
    }

    // Predict: x = F x, P = F P F^T + Q (white-noise acceleration).
    const dt = t - k.t;
    if (dt > 0) {
      const q = sigmaA ** 2;
      const dt2 = dt * dt;
      k.d += k.v * dt;
      const p00 = k.p00 + 2 * dt * k.p01 + dt2 * k.p11 + q * dt2 * dt2 / 4;
      const p01 = k.p01 + dt * k.p11 + q * dt2 * dt / 2;
      const p11 = k.p11 + q * dt2;
      k.p00 = p00;
      k.p01 = p01;
      k.p11 = p11;
      k.t = t;
    }

    // Update with the reading; Joseph form for the covariance.
    const r = sigmaR ** 2;
    const s = k.p00 + r;
    const nu = z - k.d;
    const k0 = k.p00 / s;
    const k1 = k.p01 / s;
    k.d += k0 * nu;
    k.v += k1 * nu;
    const a = 1 - k0;
    const p00 = a * a * k.p00 + k0 * k0 * r;
    const p01 = a * (k.p01 - k1 * k.p00) + k0 * k1 * r;
    const p11 = k.p11 - 2 * k1 * k.p01 + k1 * k1 * k.p00 + k1 * k1 * r;
    k.p00 = p00;
    k.p01 = p01;
    k.p11 = p11;
    k.tReading = t;
    return k.d;
  }

  // --- FFT stage ---------------------------------------------------------------
  // The low-pass read back at the newest sample. Same arithmetic as
  // fft_lowpass_last() in filterRules.py; app.py's fft_filter_ultrasonic() is
  // the numpy version for a whole window. Only the bins that survive the cut
  // are transformed, which gives the same newest sample as a full FFT, a
  // zeroed top end and an inverse FFT.
  function fftLowpassLast(values, sampleRateHz, cutoffHz) {
    const n = values.length;
    if (n < 2) return values[n - 1];

    // Least-squares straight line through the window.
    const tMean = (n - 1) / 2;
    let vMean = 0;
    for (let i = 0; i < n; i++) vMean += values[i];
    vMean /= n;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      const offset = i - tMean;
      sxx += offset * offset;
      sxy += offset * (values[i] - vMean);
    }
    const slope = sxy / sxx;

    // What the line leaves, mirrored at the newest end: 2n samples that join
    // up smoothly where the transform wraps round.
    const m = 2 * n;
    const mirrored = new Array(m);
    for (let i = 0; i < n; i++) {
      const residual = values[i] - (vMean + slope * (i - tMean));
      mirrored[i] = residual;
      mirrored[m - 1 - i] = residual;
    }

    // Rebuild sample n - 1 from the bins at or below the cutoff.
    const at = n - 1;
    let sum = 0;
    for (let k = 0; k <= m / 2; k++) {
      if (k * sampleRateHz / m > cutoffHz) break;
      let re = 0;
      let im = 0;
      for (let j = 0; j < m; j++) {
        const angle = (2 * Math.PI * k * j) / m;
        re += mirrored[j] * Math.cos(angle);
        im -= mirrored[j] * Math.sin(angle);
      }
      const phase = (2 * Math.PI * k * at) / m;
      const term = re * Math.cos(phase) - im * Math.sin(phase);
      sum += k === 0 || k === m / 2 ? term : 2 * term;
    }
    return vMean + slope * (at - tMean) + sum / m;
  }

  // Adds one Kalman output, taken at `now` (ms), to the FFT window and returns
  // the channel's value. The window's sample rate is what its timestamps say.
  function smoothWindow(filter, tracked, now) {
    const size = Math.max(0, Math.floor(tuning.fftWindow));
    if (size === 0) {
      filter.smoothed.length = 0;
      filter.smoothedAt.length = 0;
      return tracked;
    }
    filter.smoothed.push(tracked);
    filter.smoothedAt.push(now);
    while (filter.smoothed.length > size) {
      filter.smoothed.shift();
      filter.smoothedAt.shift();
    }
    const n = filter.smoothed.length;
    if (n < Math.min(FFT_MIN_SAMPLES, size)) return tracked;
    const span = (filter.smoothedAt[n - 1] - filter.smoothedAt[0]) / 1000;
    if (!(span > 0)) return tracked;
    return fftLowpassLast(filter.smoothed, (n - 1) / span, tuning.fftCutoffHz);
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
        restartSmoothing(filter);
        filter.rejects.length = 0;
        return true;
      }
    }

    filter.rejectCount += 1;
    return false;
  }

  // One new reading through the channel: slew gate, median, Kalman, FFT
  // low-pass. The median rejects single-sample spikes far better than a mean;
  // the Kalman follows the median without an average's lag; the FFT stage cuts
  // what is left above tuning.fftCutoffHz. The hold coasts through a dropped
  // echo instead of reporting the player gone. With tuning.kalman off, the
  // median goes straight to the FFT stage.
  function conditionSensor(filter, raw, now, angle = null) {
    // Back after a silence - the other node's scanning turn, as a rule. What
    // the channel remembers is where the player was a turn ago, so it starts
    // again from this reading rather than letting the median and the gate hold
    // the new readings back. A range at a new bearing is not another sample of
    // the old track either.
    if (now - filter.steppedAt > SENSOR_HOLD_MS || angle !== filter.angle) restartChannel(filter);
    filter.steppedAt = now;
    filter.angle = angle;

    // An impossible jump is treated exactly like a dropped echo: it never
    // enters the median window, so it cannot drag the value toward itself.
    if (raw !== null && !isPlausible(filter, raw, now)) raw = null;

    if (raw !== null) {
      filter.samples.push(raw);
      if (filter.samples.length > SENSOR_HISTORY) filter.samples.shift();
      const middle = median(filter.samples);
      const tracked = tuning.kalman ? kalmanUpdate(filter.kalman, middle, now / 1000) : middle;
      filter.value = smoothWindow(filter, tracked, now);
      filter.lastGoodAt = now;
      // The slew gate judges readings against the median, as it always has:
      // the stages after it lag a little, and must not tighten the gate.
      filter.anchor = middle;
      filter.anchorAt = now;
      return filter.value;
    }

    if (now - filter.lastGoodAt <= SENSOR_HOLD_MS) return filter.value;

    restartSmoothing(filter);
    filter.value = null;
    return null;
  }

  function resetSensorFilters() {
    sensorFilters.forEach((filter) => {
      restartChannel(filter);
      filter.rejectCount = 0;
      filter.steppedAt = -Infinity;
      filter.angle = null;
    });
    resetLosTrack();
    resetDynamic();
    resetDynamicRules();
    lastSeenStamp.fill(null);
    heardAt.fill(-Infinity);
    foundAt.fill(-Infinity);
    stateLog.forEach((log) => { log.length = 0; });
    closeStreak = 0;
    lastColumn = null;
    lastSeenFrameSeq = sensorFrameSeq;
    badReadingStreak = 0;
    resetCellFilter();
    sensorHold.grid = null;
    sensorHold.world = null;
    // Drops the drawn position too, so a new round opens its cursor where the
    // player is standing instead of springing across the board from wherever
    // the last one ended.
    cursorSmoother.reset();
    cursorLastStepAt = null;
  }

  window.resetSensorFilters = resetSensorFilters;

  // --- Coordinate derivation -------------------------------------------------

  let lastColumn = null;
  let closeStreak = 0;

  // --- Placing the player ----------------------------------------------------
  // The two nodes sit on the screen line at the centres of the outer columns.
  // Each is a servo scanner that reports its distance to the player and the
  // servo angle it read at. Three ways to turn that into a position, and a
  // fourth that picks between them, switched on the phone control panel
  // (positioning.method):
  //
  //   "dyn" - Dynamic, the default: whichever of the other three has kept the
  //           player in one square of the board the longest (dynamicLeader()).
  //   "los" - line of sight. Each node's reading is a point along
  //           its line of sight (its distance along its servo angle), with an
  //           uncertainty that is small along the line - the distance is good
  //           - and grows across it with the distance, with how sure the node
  //           is of its aim (found / half-found) and with the width of the
  //           player, anywhere across whom the aim may stop. In the centre
  //           column the two nodes look in from either side, so the distances
  //           cross and fix the player there. Those points feed a 2D
  //           constant-velocity Kalman filter (losTrack) one reading at a time,
  //           as they arrive. The nodes take turns to scan, so they are never
  //           read at the same moment: each reading is used once, when it
  //           arrives, and a node that is sweeping for the player (lost) is not
  //           used at all - what its beam hits is not the player.
  //   "tri" - trilateration of the two distances (trilaterate()): each is a
  //           circle around its node, and the player is where they cross. It
  //           pairs each node's distance with the other node's latest one,
  //           however old. The servo angles check the crossing: it must lie
  //           inside both sensors' beams (inBeam()), or one node is looking
  //           at something else and the crossing is not used. Then, as when
  //           only one node has a reading, the nearer node places the player
  //           by its own distance along its servo angle.
  //   "avg" - the midpoint of the two.
  //
  // All of them are worked out on every update, so the sensor panel and the
  // control panel's pad can show them side by side (Compare). Every method places the middle of the player: each
  // distance has tuning.bodyRadiusCm added first (bodyCentreCm()). x picks the
  // column (the centre one included) and y, the depth from the screen, picks
  // the row. filterRules.py (TwoSensorGeometry) is the parity-tested Python
  // port.
  //
  // The servo angle: 90 points straight out into the play area, and a larger
  // angle turns towards screen-right (larger x). That is the way the rig's
  // servos turn (the centre test on 4 Oct: read the other way, the two nodes
  // put a player standing still 160-250 cm apart) and the way the firmware's
  // limits are set (src/Config.h: LEFT turns in to 160, RIGHT to 30).

  function columnCentreCm(column) {
    return ((column + 0.5) * PLAY_WIDTH_CM) / 3;
  }

  function columnAtCm(x) {
    return Math.max(0, Math.min(2, Math.floor(x / (PLAY_WIDTH_CM / 3))));
  }

  // How far inside the board's edges a position is kept, as a share of a
  // square: off the board, the player is placed this far in from the edge,
  // inside the edge square's hole (the holes fill all but the gaps between
  // them, under a tenth of a square). Python: EDGE_INSET in filterRules.py.
  const EDGE_INSET = 0.1;
  const EDGE_INSET_X_CM = (PLAY_WIDTH_CM / 3) * EDGE_INSET;

  // A column's calibrated depth, { near, far } in cm (the defaults before
  // calibration), as rawToGrid() and the cursor use it.
  function columnSpan(column) {
    const bounds = window.getCalibrationBounds ? window.getCalibrationBounds() : null;
    return bounds ? bounds.perColumn[column] : { near: 20, far: 140 };
  }

  // Whether a node's distance puts the player on the board: the point it
  // gives along the node's servo line (straight out when the node sends no
  // angle), not the distance itself. Across the board the distance is the
  // long side of the triangle - 168 cm from the left node to the middle of
  // the far right square, 135 cm out - and against the rows' depth it threw
  // the player out. filterRules.py TwoSensorGeometry._in_play_along().
  function isInPlayAlong(slot, distance, angle) {
    if (!window.isPointInPlayArea) return true;
    const point = scannerPoint(columnCentreCm(slot), distance, angle);
    return window.isPointInPlayArea(point.x, point.y);
  }

  // The sensors' datasheet range (HC-SR04; the RCWL-1601 is a pin-compatible
  // copy): a distance outside it is not a reading. filterRules.py SENSOR_*_CM.
  const SENSOR_MIN_CM = 2;
  const SENSOR_MAX_CM = 400;

  function inSensorRange(distance) {
    return distance !== null && distance >= SENSOR_MIN_CM && distance <= SENSOR_MAX_CM;
  }

  // A node's distance to the middle of the player: what it measured, to the
  // side of them nearest it, plus tuning.bodyRadiusCm. filterRules.py
  // body_centre_cm().
  function bodyCentreCm(distance) {
    return distance + tuning.bodyRadiusCm;
  }

  // Whether the middle of the player can be at (x, y) when the node at nodeX,
  // its servo at angle, sees them: inside its beam (within
  // tuning.triBeamHalfDeg of where it points), or no more than
  // tuning.bodyHalfWidthCm outside it - the beam may have found the edge of
  // the player rather than their middle. Splits (x, y) into how far it is out
  // along the aim and how far off to the side, with the same sin and cos as
  // scannerPoint(), so in_beam() in filterRules.py agrees to the last bit. A
  // node that sends no angle has no beam to check.
  function inBeam(nodeX, angle, x, y) {
    if (angle === null) return true;
    const phi = (angle - 90) * Math.PI / 180;
    const dx = x - nodeX;
    const along = Math.sin(phi) * dx + Math.cos(phi) * y;
    const across = Math.cos(phi) * dx - Math.sin(phi) * y;
    const halfBeam = tuning.triBeamHalfDeg * Math.PI / 180;
    return along >= 0 && Math.abs(across) <= along * Math.tan(halfBeam) + tuning.bodyHalfWidthCm;
  }

  // Where the player is, from the filtered [left, centre, right] distances and
  // the servo angles they were read at (null where a node sends none).
  // Returns { x, y, source } in cm, or null when neither sensor has a reading.
  // source is "both" for a trilaterated fix, else the one sensor used. Pure:
  // no hysteresis state is touched, and x is not yet clamped to the board.
  //
  // The circles are the distances to the middle of the player
  // (bodyCentreCm()). A reading only counts toward the crossing if it is
  // inside its own column's play area. When only one does, the circles miss
  // each other, or the crossing is outside either node's beam (one sensor is
  // seeing something else), the nearer sensor places the player by its
  // distance along its servo angle - straight in front of itself if it sends
  // none.
  function trilaterate(filtered, angles = [null, null, null]) {
    const dL = inSensorRange(filtered[LEFT_SENSOR]) ? bodyCentreCm(filtered[LEFT_SENSOR]) : null;
    const dR = inSensorRange(filtered[RIGHT_SENSOR]) ? bodyCentreCm(filtered[RIGHT_SENSOR]) : null;
    const inL = dL !== null && isInPlayAlong(LEFT_SENSOR, dL, angles[LEFT_SENSOR]);
    const inR = dR !== null && isInPlayAlong(RIGHT_SENSOR, dR, angles[RIGHT_SENSOR]);

    if (inL && inR) {
      const xLeft = columnCentreCm(LEFT_SENSOR);
      const xRight = columnCentreCm(RIGHT_SENSOR);
      const base = xRight - xLeft;
      const along = (dL * dL - dR * dR + base * base) / (2 * base);
      const h2 = dL * dL - along * along;
      if (h2 >= 0) {
        const x = xLeft + along;
        const y = Math.sqrt(h2);
        if (inBeam(xLeft, angles[LEFT_SENSOR], x, y) && inBeam(xRight, angles[RIGHT_SENSOR], x, y)) {
          return { x, y, source: "both" };
        }
      }
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
    const point = scannerPoint(columnCentreCm(best.column), best.distance, angles[best.column]);
    return { x: point.x, y: point.y, source: best.column === LEFT_SENSOR ? "left" : "right" };
  }

  // The point distance out from the node at nodeX along its servo angle: 90
  // points straight out, larger turns towards screen-right (larger x); null
  // means straight out. Same arithmetic as scanner_point() in filterRules.py,
  // operation for operation, so the two agree to the last bit.
  function scannerPoint(nodeX, distance, angle) {
    const phi = ((angle === null ? 90 : angle) - 90) * Math.PI / 180;
    return { x: nodeX + distance * Math.sin(phi), y: distance * Math.cos(phi) };
  }

  // --- Line of sight: a 2D Kalman filter ---------------------------------------
  // State [x, y, vx, vy] in cm and cm/s, constant velocity with white-noise
  // acceleration, like tracking.py's 1D tracker but on the board. The player's
  // acceleration and how far off its aim a node may be are in `tuning`; all
  // the numbers match the FilterConfig los_* defaults in filterRules.py.
  const LOS_RANGE_SIGMA_CM = 3;           // a filtered distance, along the line of sight
  const LOS_V0_SIGMA_CM_S = 100;          // a new track's velocity uncertainty
  const LOS_GATE_NIS = 13.8;              // chi-square, 2 dof, 99.9 %: further off is an outlier
  const LOS_RELOCK_READINGS = 6;          // one node's outliers in a row that move the track instead
  const LOS_TRACK_TIMEOUT_MS = 1500;      // no usable reading for this long: no position
  const LOS_BOTH_WINDOW_MS = 2500;        // both nodes fed the track within this: source "both"
  const SCAN_FOUND = 0;                   // scanState: both heads hear the player
  const SCAN_HALF = 1;                    // scanState: one head hears the player
  const SCAN_LOST = 2;                    // scanState: sweeping, the player is not in sight

  // Small dense matrices as arrays of rows, multiplied in a fixed order so the
  // Python port gets the same numbers.
  function matMul(a, b) {
    const out = [];
    for (let i = 0; i < a.length; i++) {
      const row = [];
      for (let j = 0; j < b[0].length; j++) {
        let sum = 0;
        for (let k = 0; k < b.length; k++) sum += a[i][k] * b[k][j];
        row.push(sum);
      }
      out.push(row);
    }
    return out;
  }

  function matTranspose(a) {
    return a[0].map((_, j) => a.map((row) => row[j]));
  }

  function matAdd(a, b) {
    return a.map((row, i) => row.map((value, j) => value + b[i][j]));
  }

  // One node's reading as a measurement: the point along its line of sight
  // (distance is to the middle of the player, bodyCentreCm()), and that
  // point's covariance (2x2, cm^2) - LOS_RANGE_SIGMA_CM along the line; across
  // it, the distance times the bearing uncertainty and tuning.bodyHalfWidthCm
  // (the aim can stop anywhere across the player) added in quadrature. So
  // where the two nodes look in from either side, as in the centre column,
  // each one's distance fixes the player across the other's line. `repeats`
  // is how many readings in a row have already used this same aim: a servo
  // that holds still repeats the same aim error, on the same part of the
  // player, on every reading, so the k-th repeat counts 1/(k+1)^2 as much
  // across the line - a held aim adds up to about one and a half readings'
  // worth, however long it is held - while the distance along the line
  // counts in full every time.
  function lineOfSight(nodeX, distance, angle, state, repeats) {
    const phi = (angle - 90) * Math.PI / 180;
    const along = [Math.sin(phi), Math.cos(phi)];
    const across = [Math.cos(phi), -Math.sin(phi)];
    const bearingDeg = state === 0 ? tuning.losBearingFoundDeg
      : state === 1 ? tuning.losBearingHalfDeg : tuning.losBearingUnknownDeg;
    const radial = LOS_RANGE_SIGMA_CM * LOS_RANGE_SIGMA_CM;
    const aim = distance * bearingDeg * Math.PI / 180;
    const body = tuning.bodyHalfWidthCm;
    const tangential = (aim * aim + body * body) * (repeats + 1) * (repeats + 1);
    const cov = [[0, 0], [0, 0]];
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        cov[i][j] = radial * along[i] * along[j] + tangential * across[i] * across[j];
      }
    }
    return { x: nodeX + distance * Math.sin(phi), y: distance * Math.cos(phi), cov };
  }

  function makeLosTrack() {
    return {
      x: null,                              // [x, y, vx, vy]
      P: null,                              // 4x4 covariance
      t: 0,                                 // time of x, s
      updatedAt: -Infinity,                 // ms of the last reading the track took
      fedAt: [-Infinity, -Infinity, -Infinity], // ms each slot last fed it
      aimedAt: [null, null, null],          // the servo angle each slot's aim was last taken at
      aimRepeats: [0, 0, 0],                // readings in a row that have used that aim since
      lastSlot: null,
      outliers: [0, 0, 0],                  // each slot's readings in a row that failed the gate
    };
  }

  const losTrack = makeLosTrack();

  function resetLosTrack() {
    Object.assign(losTrack, makeLosTrack());
  }

  function losTook(slot, now) {
    losTrack.updatedAt = now;
    losTrack.fedAt[slot] = now;
    losTrack.lastSlot = slot;
  }

  // A new track at this reading, still, as uncertain as the reading itself.
  function losStart(m, slot, now) {
    const v0 = LOS_V0_SIGMA_CM_S * LOS_V0_SIGMA_CM_S;
    losTrack.x = [m.x, m.y, 0, 0];
    losTrack.P = [
      [m.cov[0][0], m.cov[0][1], 0, 0],
      [m.cov[1][0], m.cov[1][1], 0, 0],
      [0, 0, v0, 0],
      [0, 0, 0, v0],
    ];
    losTrack.t = now / 1000;
    losTrack.outliers = [0, 0, 0];
    losTook(slot, now);
  }

  // x = F x, P = F P F^T + Q, to time t (s).
  function losPredict(t) {
    const dt = t - losTrack.t;
    if (dt <= 0) return;
    const q = tuning.losAccelCmS2 * tuning.losAccelCmS2;
    const dt2 = dt * dt;
    const a = q * dt2 * dt2 / 4;
    const b = q * dt2 * dt / 2;
    const c = q * dt2;
    const F = [[1, 0, dt, 0], [0, 1, 0, dt], [0, 0, 1, 0], [0, 0, 0, 1]];
    const Q = [[a, 0, b, 0], [0, a, 0, b], [b, 0, c, 0], [0, b, 0, c]];
    const x = losTrack.x;
    losTrack.x = [x[0] + x[2] * dt, x[1] + x[3] * dt, x[2], x[3]];
    losTrack.P = matAdd(matMul(matMul(F, losTrack.P), matTranspose(F)), Q);
    losTrack.t = t;
  }

  // A reading the gate turned away. LOS_RELOCK_READINGS of those in a row from
  // one node mean the player is somewhere else, and the track restarts at this
  // reading. Counted per node: the other node's readings can pass the gate on
  // the slack across its line (the player's width) while this node's distance
  // keeps saying the track is wrong, and must not keep it from moving.
  // Returns whether it did.
  function losOutlier(m, slot, now) {
    losTrack.outliers[slot] += 1;
    if (losTrack.outliers[slot] < LOS_RELOCK_READINGS) return false;
    losStart(m, slot, now);
    return true;
  }

  // The rest of a Kalman update once the gain K (4 x n) is known: x += K nu and
  // the Joseph-form covariance (I - K H) P (I - K H)^T + K R K^T, for the
  // measurement matrix H (n x 4) and its noise R (n x n).
  function losApply(K, nu, H, R, slot, now) {
    const P = losTrack.P;
    losTrack.x = losTrack.x.map((value, i) => value + K[i].reduce((sum, k, j) => sum + k * nu[j], 0));
    const KH = matMul(K, H);
    const A = KH.map((row, i) => row.map((value, j) => (i === j ? 1 : 0) - value));
    losTrack.P = matAdd(matMul(matMul(A, P), matTranspose(A)), matMul(matMul(K, R), matTranspose(K)));
    losTrack.outliers[slot] = 0;
    losTook(slot, now);
  }

  // One node's line of sight into the track: distance and aim together. A
  // reading too far from where the track expects the player (the gate) is
  // left out. Returns whether the track took the reading.
  function losObserve(m, slot, now) {
    if (losTrack.x === null) {
      losStart(m, slot, now);
      return true;
    }
    losPredict(now / 1000);

    const P = losTrack.P;
    const nu = [m.x - losTrack.x[0], m.y - losTrack.x[1]];
    const s00 = P[0][0] + m.cov[0][0];
    const s01 = P[0][1] + m.cov[0][1];
    const s10 = P[1][0] + m.cov[1][0];
    const s11 = P[1][1] + m.cov[1][1];
    const det = s00 * s11 - s01 * s10;
    if (!(det > 0)) return false;
    const Si = [[s11 / det, -s01 / det], [-s10 / det, s00 / det]];
    const nis = nu[0] * (Si[0][0] * nu[0] + Si[0][1] * nu[1]) +
      nu[1] * (Si[1][0] * nu[0] + Si[1][1] * nu[1]);
    if (nis > LOS_GATE_NIS) return losOutlier(m, slot, now);

    // K = P H^T S^-1; H picks x and y, so P H^T is P's first two columns.
    const K = matMul(P.map((row) => [row[0], row[1]]), Si);
    losApply(K, nu, [[1, 0, 0, 0], [0, 1, 0, 0]], m.cov, slot, now);
    return true;
  }

  // Feeds the track every node reading that has the player in its line of
  // sight: new in this update (a reading is used once, when it arrives), with
  // a distance and a servo angle, from a node that is not sweeping. An aim is
  // new when the servo has moved, or the node has just come back for its turn;
  // after that each reading at the same aim counts for less across the line
  // (lineOfSight()). With tuning.kalman off, each reading starts the track
  // again at its own point: no gate, nothing kept from before.
  function stepLosTrack(filtered, scans, fresh, now) {
    [LEFT_SENSOR, RIGHT_SENSOR].forEach((slot) => {
      const scan = scans[slot];
      if (!fresh[slot] || filtered[slot] === null || scan.angle === null || scan.state === SCAN_LOST) return;
      const newAim = losTrack.x === null || scan.angle !== losTrack.aimedAt[slot] ||
        now - losTrack.fedAt[slot] > SENSOR_HOLD_MS;
      const repeats = newAim ? 0 : losTrack.aimRepeats[slot] + 1;
      const m = lineOfSight(columnCentreCm(slot), bodyCentreCm(filtered[slot]), scan.angle, scan.state, repeats);
      let took = true;
      if (tuning.kalman) took = losObserve(m, slot, now);
      else losStart(m, slot, now);
      if (took) {
        losTrack.aimedAt[slot] = scan.angle;
        losTrack.aimRepeats[slot] = repeats;
      }
    });
    if (losTrack.x !== null && now - losTrack.updatedAt > LOS_TRACK_TIMEOUT_MS) resetLosTrack();
  }

  // The track's position, or null when it has had nothing usable for too long.
  function losFix(now) {
    if (losTrack.x === null || now - losTrack.updatedAt > LOS_TRACK_TIMEOUT_MS) return null;
    const recent = (slot) => now - losTrack.fedAt[slot] <= LOS_BOTH_WINDOW_MS;
    const source = recent(LEFT_SENSOR) && recent(RIGHT_SENSOR) ? "both"
      : losTrack.lastSlot === LEFT_SENSOR ? "left" : "right";
    return { x: losTrack.x[0], y: losTrack.x[1], source };
  }

  // All three positions for this update, { los, tri, avg }, each { x, y,
  // source } or null. Pure apart from reading the track. With no servo angle
  // from either node there is no line of sight, and every method is
  // trilateration, as it always was for that firmware.
  function solvePositions(filtered, angles, now) {
    const tri = trilaterate(filtered, angles);
    if (angles[LEFT_SENSOR] === null && angles[RIGHT_SENSOR] === null) {
      return { los: tri, tri, avg: tri };
    }
    const los = losFix(now);
    let avg = los || tri;
    if (los && tri) {
      avg = {
        x: (los.x + tri.x) / 2,
        y: (los.y + tri.y) / 2,
        source: los.source === tri.source ? los.source : "both",
      };
    }
    return { los, tri, avg };
  }

  // --- Dynamic: the steadiest method ------------------------------------------
  // "dyn" places the player by whichever of line of sight, trilateration and
  // the average has kept them in one square of the board the longest. A
  // method whose square keeps changing - bouncing between columns, say -
  // never builds up any time, so it is passed over while another holds still.
  //
  // Time in a square counts up to tuning.dynamicSteadyMs (1 s). Past that a
  // method is fully steady, and of two fully steady methods the first in
  // DYNAMIC_METHODS wins: line of sight, then trilateration, then the average.
  // So a method stuck on something that never moves (furniture, say) can lead
  // only until line of sight has held its own square for that long.
  //
  // A square is a cell of the board, or off it: out of bounds is a square too.
  // A method with no position has no square and is out of the running until
  // it has one again. Python: DynamicPicker in filterRules.py.
  const DYNAMIC_METHODS = ["los", "tri", "avg"];
  const OFF_BOARD = -1;
  const dynamic = {
    square: { los: null, tri: null, avg: null },   // gx * 3 + gy, OFF_BOARD, or null
    since: { los: null, tri: null, avg: null },    // ms: when it entered that square
  };

  function resetDynamic() {
    DYNAMIC_METHODS.forEach((method) => {
      dynamic.square[method] = null;
      dynamic.since[method] = null;
    });
  }

  // The square a method's position is in, as above. No hysteresis: a position
  // that flicks back and forth across a boundary changes square every time.
  function squareOf(fix) {
    if (!fix) return null;
    if (fix.x < 0 || fix.x > PLAY_WIDTH_CM) return OFF_BOARD;
    const column = columnAtCm(fix.x);
    const grid = window.rawToGrid(column, fix.y, null);
    if (!grid || !grid.inside) return OFF_BOARD;
    return column * 3 + grid.gy;
  }

  // Once per new reading: each method's square, and since when it has been in
  // it.
  function stepDynamic(fixes, now) {
    DYNAMIC_METHODS.forEach((method) => {
      const square = squareOf(fixes[method]);
      if (square === null) {
        dynamic.square[method] = null;
        dynamic.since[method] = null;
      } else if (square !== dynamic.square[method]) {
        dynamic.square[method] = square;
        dynamic.since[method] = now;
      }
    });
  }

  // The method Dynamic follows right now, or null when none has a position. A
  // position not yet stepped (just after a reset) has been held for no time.
  function dynamicLeader(fixes, now) {
    let leader = null;
    let best = -Infinity;
    DYNAMIC_METHODS.forEach((method) => {
      if (!fixes[method]) return;
      const since = dynamic.since[method];
      const held = since === null ? 0 : Math.min(now - since, tuning.dynamicSteadyMs);
      if (held > best) {
        best = held;
        leader = method;
      }
    });
    return leader;
  }

  // --- Dynamic's rules: the far corners, the column lock, a lone node ---------
  // Checked before the steadiest method (Aaron, 5 Oct), in this order. Each
  // can be switched off from the control panel (setDynamicRules()).
  //
  // 1. The near node in its far corner (tuning.cornerNode). A1 and A3, the
  //    far-left and far-right squares, are far from the opposite node - the
  //    back-left square is some 156 cm from the right node, at a shallow
  //    angle. When the left node is confident (rule 3) and its own reading
  //    puts the player in A1, that reading places them and the right node's
  //    readings are left out; the same for the right node and A3.
  //
  // 2. The column lock (tuning.columnLock), from the two servo lines. Each
  //    node's servo points where it last found or half-found the player; if
  //    both have done so in the last tuning.centreSeenMs, where their lines
  //    cross says which column the player is in, wherever the methods put
  //    them. The line from a node, not its distance, is what the lock
  //    trusts: a player is hard to place by distance because each node's
  //    beam finds the edge of their body.
  //    - The centre: the lines cross in the centre column. x is the
  //      crossing's, kept COLUMN_MARGIN_CM inside the column so the column
  //      hysteresis cannot hold the player in the column they came from; y is
  //      the steadiest method's, or the crossing's when no method has a
  //      position. Once the lines have crossed in the centre the player stays
  //      there for tuning.centreHoldMs while both nodes still see them, even
  //      if the crossing strays just outside: standing still in the centre
  //      must never touch a side column (Aaron). On the rig on 5 Oct the
  //      crossing strayed to 103.5 cm for two readings in 20 minutes.
  //    - The sides: the lines cross at least tuning.sideLockDepthCm inside
  //      the left or right column (and on the board). No hold, and it ends
  //      any centre hold. Without the depth, the servos' lean (they read
  //      20-30 degrees further in than the player on 4 Oct) put the crossing
  //      in a side column while the player walked the centre: in that run's
  //      replay walk-centre fell from 100 % to 76 % in its column.
  //    (Aaron's first form of the centre, LEFT above 90 and RIGHT below it,
  //    holds anywhere between the two nodes, which sit in the middle of the
  //    outer columns; on the 4 Oct centre run it said centre at the left
  //    spot every time. The crossing said so at the left spot 0 % of the
  //    time and 81-100 % at the centre spots.)
  //
  // 3. A lone confident node (tuning.loneNode). A node whose last
  //    tuning.confidentReadings readings all found the player (both heads),
  //    the latest in the last tuning.confidentMs, and whose own reading - its
  //    distance along its servo line - puts the player inside the play area
  //    (across the board, and between its column's near and far edges), is
  //    confident. If only one node is, that reading places the player and the
  //    other node's readings are left out. When both are, the methods place
  //    the player as before. (On 5 Oct the left node, turned fully in, found
  //    something 9 cm in front of the screen line, and at times something off
  //    the left edge; neither is the player.)
  //
  // Python: TwoSensorGeometry._rule() in filterRules.py.
  const seenAim = [null, null, null];   // { at, angle }: a slot's last new reading that found or half-found the player
  const foundStreak = [0, 0, 0];        // its new readings in a row that found the player
  let centreHeld = null;                // { at, x, y }: when and where the lines last crossed in the centre column

  function resetDynamicRules() {
    seenAim.fill(null);
    foundStreak.fill(0);
    centreHeld = null;
  }

  // Once per update: this update's new readings. foundAt, which the
  // confidence also reads, is noted by bothNodesLost().
  function stepDynamicRules(filtered, scans, fresh, now) {
    [LEFT_SENSOR, RIGHT_SENSOR].forEach((slot) => {
      if (!fresh[slot]) return;
      const { state, angle } = scans[slot];
      const reading = filtered[slot] !== null;
      foundStreak[slot] = reading && state === SCAN_FOUND ? foundStreak[slot] + 1 : 0;
      if (reading && angle !== null && (state === SCAN_FOUND || state === SCAN_HALF)) {
        seenAim[slot] = { at: now, angle };
      }
    });
    const crossing = linesCrossing(now);
    if (crossing && inCentreColumn(crossing.x)) centreHeld = { at: now, x: crossing.x, y: crossing.y };
    else if (crossing && deepSideColumn(crossing.x) !== null) centreHeld = null;
  }

  // Whether both nodes found or half-found the player in the last
  // tuning.centreSeenMs.
  function bothLinesRecent(now) {
    const left = seenAim[LEFT_SENSOR];
    const right = seenAim[RIGHT_SENSOR];
    return Boolean(left && right) && now - left.at <= tuning.centreSeenMs && now - right.at <= tuning.centreSeenMs;
  }

  // Where the two nodes' servo lines cross, { x, y }, or null when one is not
  // recent or they do not meet in front of the nodes.
  function linesCrossing(now) {
    if (!bothLinesRecent(now)) return null;
    const tanLeft = Math.tan((seenAim[LEFT_SENSOR].angle - 90) * Math.PI / 180);
    const tanRight = Math.tan((seenAim[RIGHT_SENSOR].angle - 90) * Math.PI / 180);
    if (!(tanLeft > tanRight)) return null;
    const y = (columnCentreCm(RIGHT_SENSOR) - columnCentreCm(LEFT_SENSOR)) / (tanLeft - tanRight);
    return { x: columnCentreCm(LEFT_SENSOR) + y * tanLeft, y };
  }

  function inCentreColumn(x) {
    const pitch = PLAY_WIDTH_CM / 3;
    return x >= pitch && x <= 2 * pitch;
  }

  // The side column, 0 or 2, the lines' crossing is at least
  // tuning.sideLockDepthCm inside (and on the board), or null.
  function deepSideColumn(x) {
    const pitch = PLAY_WIDTH_CM / 3;
    if (x >= 0 && x <= pitch - tuning.sideLockDepthCm) return LEFT_SENSOR;
    if (x <= PLAY_WIDTH_CM && x >= 2 * pitch + tuning.sideLockDepthCm) return RIGHT_SENSOR;
    return null;
  }

  // The column lock, { by: "centre" | "lock-left" | "lock-right", fix }, or
  // null: the lines cross in the centre column, or deep in a side column, or
  // the centre is still held (tuning.centreHoldMs, both lines recent).
  function columnLock(steadiest, now) {
    const crossing = linesCrossing(now);
    const pitch = PLAY_WIDTH_CM / 3;
    const centre = (at) => ({
      by: "centre",
      fix: {
        x: Math.max(pitch + COLUMN_MARGIN_CM, Math.min(2 * pitch - COLUMN_MARGIN_CM, at.x)),
        y: steadiest ? steadiest.y : at.y,
        source: "both",
      },
    });
    if (crossing && inCentreColumn(crossing.x)) return centre(crossing);
    const side = crossing ? deepSideColumn(crossing.x) : null;
    if (side !== null) {
      return {
        by: side === LEFT_SENSOR ? "lock-left" : "lock-right",
        fix: { x: crossing.x, y: steadiest ? steadiest.y : crossing.y, source: "both" },
      };
    }
    if (centreHeld && now - centreHeld.at <= tuning.centreHoldMs && bothLinesRecent(now)) return centre(centreHeld);
    return null;
  }

  // A confident node's own reading, { x, y } - its distance along its servo
  // line - or null when the node is not confident or that point is outside
  // the play area.
  function confidentPoint(slot, filtered, scans, now) {
    if (foundStreak[slot] < tuning.confidentReadings || now - foundAt[slot] > tuning.confidentMs ||
      filtered[slot] === null || scans[slot].angle === null) return null;
    const point = scannerPoint(columnCentreCm(slot), bodyCentreCm(filtered[slot]), scans[slot].angle);
    if (point.x < 0 || point.x > PLAY_WIDTH_CM) return null;
    const span = columnSpan(columnAtCm(point.x));
    return point.y >= span.near && point.y <= span.far ? point : null;
  }

  // Whether a node's own reading puts the player in its far corner: A1, the
  // far-left square, for the left node; A3, the far-right one, for the right.
  function inFarCorner(slot, point) {
    const column = slot === LEFT_SENSOR ? 0 : 2;
    if (columnAtCm(point.x) !== column) return false;
    const grid = window.rawToGrid(column, point.y, null);
    return Boolean(grid) && grid.gy === GRID_ROWS - 1;
  }

  // The rule placing the player for Dynamic, { by, fix: { x, y, source } } -
  // by is "corner-left" | "corner-right" (rule 1), "centre" | "lock-left" |
  // "lock-right" (rule 2) or "left" | "right" (rule 3) - or null to follow the
  // steadiest method, whose position is `steadiest`.
  function dynamicRule(filtered, scans, steadiest, now) {
    const points = [LEFT_SENSOR, RIGHT_SENSOR]
      .map((slot) => ({ slot, point: confidentPoint(slot, filtered, scans, now) }))
      .filter((c) => c.point);
    const side = (slot) => (slot === LEFT_SENSOR ? "left" : "right");
    if (tuning.cornerNode) {
      const corner = points.find((c) => inFarCorner(c.slot, c.point));
      if (corner) {
        const { slot, point } = corner;
        return { by: `corner-${side(slot)}`, fix: { x: point.x, y: point.y, source: side(slot) } };
      }
    }
    if (tuning.columnLock) {
      const lock = columnLock(steadiest, now);
      if (lock) return lock;
    }
    if (tuning.loneNode && points.length === 1) {
      const { slot, point } = points[0];
      return { by: side(slot), fix: { x: point.x, y: point.y, source: side(slot) } };
    }
    return null;
  }

  // --- Which method places the player ----------------------------------------
  // In switch order. Choosing any but Dynamic turns Dynamic off.
  const POSITION_METHODS = ["dyn", "los", "tri", "avg"];
  // Both are switched on the phone's /control page only; the game board only
  // ever draws the one cursor (Aaron, 5 Oct).
  const positioning = {
    method: "dyn",   // what drives the cursor and the game
    compare: true,   // ring line of sight, trilateration and the average on the control panel's pad
  };

  window.getPositionMethod = function getPositionMethod() {
    return positioning.method;
  };

  // Every method with its label, in switch order - what the phone control
  // panel draws its buttons from.
  window.getPositionMethods = function getPositionMethods() {
    return POSITION_METHODS.map((id) => ({ id, label: METHOD_STYLES[id].label }));
  };

  window.setPositionMethod = function setPositionMethod(method) {
    if (POSITION_METHODS.includes(method)) {
      positioning.method = method;
      console.info(`[position] ${method}`);
    }
    return positioning.method;
  };

  window.getPositionCompare = function getPositionCompare() {
    return positioning.compare;
  };

  window.setPositionCompare = function setPositionCompare(on) {
    positioning.compare = Boolean(on);
    return positioning.compare;
  };

  // What the control panel's Dynamic button adds to its name while Dynamic is
  // on and placing the player: the method it follows ("LOS", "TRI", "AVG") or
  // the rule ("MID", "L", "R"); null otherwise.
  window.getDynamicFollowing = function getDynamicFollowing() {
    const following = gameState.sensor && gameState.sensor.placedBy;
    if (positioning.method !== "dyn" || !following) return null;
    if (METHOD_STYLES[following]) return METHOD_STYLES[following].short;
    return DYNAMIC_RULE_SHORT[following] || null;
  };

  // The Kalman switch, on by default; see tuning.kalman. Takes effect from
  // the next reading.
  window.getKalman = function getKalman() {
    return tuning.kalman;
  };

  window.setKalman = function setKalman(on) {
    tuning.kalman = Boolean(on);
    console.info(`[kalman] ${tuning.kalman ? "on" : "off"}`);
    return tuning.kalman;
  };

  // Which slots carry a reading not seen before. The server stamps each node's
  // latest message (last_seen), and only one node scans at a time, so between
  // its turns a node's last reading is repeated in every update. A slot with
  // no reading counts as new, so its hold runs out as it always did; a node
  // with no stamp (the parity trace) is new on every update. Mirrors the
  // `fresh` mask serverFilter.py hands filterRules.py.
  const lastSeenStamp = [null, null, null];
  const heardAt = [-Infinity, -Infinity, -Infinity];   // ms, a slot's last new reading
  const foundAt = [-Infinity, -Infinity, -Infinity];   // ms, its last new one with both heads on the player
  // Each node's scan states this round, one per reading that arrived, the
  // latest LOST_READINGS_MAX of them (bothNodesLost()).
  const stateLog = [[], [], []];

  // Which slots carry a new reading (fresh, see above), and which nodes'
  // messages actually arrived this update (heard): a new stamp, or every new
  // update for a node with none. fresh also marks a slot with no reading, so
  // a lost node's "no echo" would count again in every update while the other
  // node takes its turn; heard counts each reading once. serverFilter.py
  // passes the same as heard (the reporting node only).
  function freshSlots(list, raw, isNewReading, now) {
    const heard = [false, false, false];
    const fresh = raw.map((value, slot) => {
      if (!isNewReading) return false;
      const node = list[slot];
      const stamp = node && node.last_seen !== undefined ? node.last_seen : null;
      heard[slot] = Boolean(node) && (stamp === null || stamp !== lastSeenStamp[slot]);
      const isNew = value === null || stamp === null || stamp !== lastSeenStamp[slot];
      lastSeenStamp[slot] = stamp;
      if (isNew && value !== null) heardAt[slot] = now;
      return isNew;
    });
    return { fresh, heard };
  }

  // A reading's score towards a node being lost (Aaron, 5 Oct): found +1,
  // half 0, lost -1.
  function lostScore(state) {
    return state === SCAN_FOUND ? 1 : state === SCAN_LOST ? -1 : 0;
  }

  // Each node's score now, [left, right], for the control panel: { score,
  // readings } - score the sum over its last tuning.lostReadings readings
  // (0 or less is lost), or null until it has had that many this round.
  window.getLostScores = function getLostScores() {
    const n = tuning.lostReadings;
    return [LEFT_SENSOR, RIGHT_SENSOR].map((slot) => {
      const log = stateLog[slot];
      const score = log.length < n ? null : log.slice(-n).reduce((sum, entry) => sum + lostScore(entry), 0);
      return { score, readings: Math.min(log.length, n) };
    });
  };

  // Whether both nodes are lost. A node is lost when its last
  // tuning.lostReadings readings' scores (lostScore()) add up to 0 or less:
  // on average half or lost, so the odd found reading among lost ones does
  // not stop it, and a node mostly finding the player is never lost. Each
  // reading counts once, when it arrives (heard), and a node waiting for its
  // turn keeps the readings of its last one. A node is not lost until it has
  // had that many readings this round, and one that sends no scan state never
  // is. Notes this update's readings first (and foundAt, as before).
  // TwoSensorGeometry._nobody_found() in filterRules.py.
  function bothNodesLost(scans, fresh, heard, now) {
    const lost = (slot) => {
      const state = scans[slot].state;
      if (fresh[slot] && state === SCAN_FOUND) foundAt[slot] = now;
      const log = stateLog[slot];
      if (heard[slot] && state !== null) log.push(state);
      if (log.length > LOST_READINGS_MAX) log.shift();
      const n = tuning.lostReadings;
      if (log.length < n) return false;
      return log.slice(-n).reduce((sum, entry) => sum + lostScore(entry), 0) <= 0;
    };
    const left = lost(LEFT_SENSOR);
    const right = lost(RIGHT_SENSOR);
    return left && right;
  }

  // Input:  [left, centre, right] node records, nulls allowed (calibration order).
  //         The centre is ignored: the rig has no centre sensor.
  // Output: {
  //   status:     "ok" | "too-close" | "no-signal" | "out-of-bounds" - out of
  //               bounds only when nobodyFound,
  //   column:     the column the player is in - 0 left, 1 centre, 2 right,
  //   distanceCm: the player's depth from the screen (y),
  //   xCm, yCm:   the player's position in cm, source: "both" | "left" | "right",
  //   raw:        [l, c, r] node distances straight off the wire, for debugging,
  //   filtered:   [l, c, r] after median, Kalman, FFT and hold,
  //   fresh:      [l, c, r] whether each slot brought a new reading this update,
  //   heardMsAgo: [l, c, r] ms since each node's last new reading,
  //   fixes:      { dyn, los, tri, avg } - every method's position, see
  //               solvePositions(), dynamicLeader() and dynamicRule(),
  //   method:     the method switched on,
  //   placedBy:   where the position above came from: the method switched
  //               on ("los" | "tri" | "avg"), or, with Dynamic on, one of its
  //               rules (dynamicRule(): "corner-left" | "corner-right" |
  //               "centre" | "lock-left" | "lock-right" | "left" | "right")
  //               or the steadiest method,
  //   depth:      [l, c, r] each node's own depth reading (filtered distance to
  //               the middle of the player, bodyCentreCm(), turned by its servo
  //               angle) - what corner calibration captures,
  //   scans:      [l, c, r] each node's scanner fields, see readScan(),
  //   nobodyFound: both nodes are lost over their last tuning.lostReadings
  //               readings (bothNodesLost()) - "out-of-bounds", with no hold,
  //   offBoard:   the position was off the board (or past its calibrated
  //               depth) and has been brought onto the edge square,
  //   configured: how many sensors currently have a usable value
  // }
  function readSensorCoordinate(orderedNodes) {
    const list = Array.isArray(orderedNodes) ? orderedNodes : [];
    const now = performance.now();

    const raw = [readDistance(list[LEFT_SENSOR]), null, readDistance(list[RIGHT_SENSOR])];
    const scans = [readScan(list[LEFT_SENSOR]), NO_SCAN, readScan(list[RIGHT_SENSOR])];
    const angles = scans.map((scan) => scan.angle);

    // Fresh data, or the same reading being polled again by the render loop?
    // Only a node's new reading moves its filters and the track: the Kalman
    // and FFT stages count readings, and one reading polled at 60 fps - or
    // repeated in every update while the other node takes its scanning turn -
    // is still one reading.
    const isNewReading = sensorFrameSeq !== lastSeenFrameSeq;
    lastSeenFrameSeq = sensorFrameSeq;
    const { fresh, heard } = freshSlots(list, raw, isNewReading, now);

    const filtered = raw.map((value, slot) =>
      fresh[slot] ? conditionSensor(sensorFilters[slot], value, now, angles[slot]) : sensorFilters[slot].value);
    if (isNewReading) stepLosTrack(filtered, scans, fresh, now);
    const nobodyFound = bothNodesLost(scans, fresh, heard, now);
    if (isNewReading) stepDynamicRules(filtered, scans, fresh, now);
    const fixes = solvePositions(filtered, angles, now);
    if (isNewReading) stepDynamic(fixes, now);
    const steadiest = dynamicLeader(fixes, now);
    const rule = dynamicRule(filtered, scans, steadiest ? fixes[steadiest] : null, now);
    const following = rule ? rule.by : steadiest;
    fixes.dyn = rule ? rule.fix : steadiest ? fixes[steadiest] : null;
    const placedBy = positioning.method === "dyn" ? following : positioning.method;
    const configured = filtered.filter((d) => d !== null).length;
    const depth = filtered.map((distance, slot) =>
      distance === null || slot === 1 ? null
        : scannerPoint(columnCentreCm(slot), bodyCentreCm(distance), angles[slot]).y);
    const heardMsAgo = heardAt.map((at) => now - at);

    const base = {
      raw, filtered, depth, scans, configured, isNewReading, fresh, heardMsAgo,
      fixes, method: positioning.method, placedBy, nobodyFound: false, offBoard: false,
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

    const position = fixes[positioning.method];
    const x = position ? Math.max(EDGE_INSET_X_CM, Math.min(PLAY_WIDTH_CM - EDGE_INSET_X_CM, position.x)) : null;

    // Safety outranks every other state, including loss of signal. The column
    // is reported without advancing the hysteresis below.
    if (tooClose) {
      const column = position ? columnAtCm(x) : null;
      return { ...base, column, distanceCm: rawMin, status: "too-close" };
    }

    // Both nodes are lost over their last readings (bothNodesLost()): nobody
    // is on the board, whatever any method still makes of old or stray
    // readings. The only Out of bounds there is; updateSensorCursor() does
    // not ride it out on the last square.
    if (nobodyFound) {
      lastColumn = null;
      return { ...base, status: "out-of-bounds", nobodyFound: true };
    }

    if (position === null) {
      lastColumn = null;
      return { ...base, status: "no-signal" };
    }

    let column = columnAtCm(x);

    // Column hysteresis: next to a column boundary the previous column holds,
    // so noise does not flick the cursor between neighbours.
    if (lastColumn !== null && Math.abs(column - lastColumn) === 1) {
      const boundary = (PLAY_WIDTH_CM / 3) * Math.max(column, lastColumn);
      if (Math.abs(x - boundary) < COLUMN_MARGIN_CM) column = lastColumn;
    }

    // Off the board - past a side, past the far edge, in front of the near
    // one - the player is kept on the edge square, and the game carries on:
    // x above and y here are brought EDGE_INSET of a square inside the
    // board's edges, so the cursor sits on that square's hole (the hover test
    // needs it there). The column's calibrated span sets the depth.
    const span = columnSpan(column);
    const insetY = ((span.far - span.near) / 3) * EDGE_INSET;
    const y = Math.max(span.near + insetY, Math.min(span.far - insetY, position.y));
    const offBoard = position.x < 0 || position.x > PLAY_WIDTH_CM ||
      position.y < span.near || position.y > span.far;

    lastColumn = column;
    return { ...base, column, distanceCm: y, xCm: x, yCm: y, source: position.source, offBoard, status: "ok" };
  }

  window.readSensorCoordinate = readSensorCoordinate;

  // Shared with callibrate_corners.js so both screens reject the same readings.
  window.SENSOR_LIMITS = { maxCm: MAX_COORD_CM };

  // Shared with calibrate.js, which needs per-node distances to work out which
  // physical sensor the operator is holding a hand in front of.
  window.readNodeDistance = readDistance;

  // --- Which way up the board is drawn ----------------------------------------
  // The row nearest the screen is drawn at the TOP of the board, so a player
  // who steps towards the screen sees the cursor move up - the board reads like
  // a map held facing the screen. Only the drawing is flipped: gy 0 is still
  // the row nearest the screen everywhere else (rawToGrid(), the cell vote,
  // filterRules.py), and left/right is unchanged. Set to false to draw the
  // near row at the bottom again.
  const NEAR_ROW_AT_TOP = true;
  const GRID_ROWS = 3;

  // Grid row (gy, 0 = nearest the screen) -> board row counted from the top.
  function boardRow(gy) {
    return NEAR_ROW_AT_TOP ? gy : GRID_ROWS - 1 - gy;
  }

  // Grid coordinate (0-2; gy 0 = nearest the screen) -> canvas pixels at the
  // centre of the matching hole.
  window.gridToCanvasPoint = function gridToCanvasPoint(canvas, gx, gy) {
    const layout = window.getGameGridLayout(canvas);
    const span = layout.gridSize - layout.cellSize;
    return {
      x: layout.gridLeft + (gx / 2) * span + layout.cellSize / 2,
      y: layout.gridTop + (boardRow(gy) / 2) * span + layout.cellSize / 2,
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
  // the first column's centre, and depth grows away from the near edge, which
  // is drawn at the top (boardRow()).
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
    const rowDepth = Math.max(1e-6, (span.far - span.near) / GRID_ROWS);

    // How many hole-widths from column 0's centre, and how far through the
    // three rows, measured from the near edge. A column centre is an integer,
    // and the middle of row r sits at t = r + 0.5.
    const acrossHoles = (xCm - columnCentreCm(0)) / COLUMN_PITCH_CM;
    const depthT = (yCm - span.near) / rowDepth;

    // Board rows counted from the top, continuously: the middle of grid row r
    // lands on boardRow(r), the same hole centre gridToCanvasPoint gives.
    const rowsFromTop = NEAR_ROW_AT_TOP ? depthT - 0.5 : GRID_ROWS - 0.5 - depthT;

    return {
      x: layout.gridLeft + layout.cellSize / 2 + acrossHoles * pitch,
      y: layout.gridTop + layout.cellSize / 2 + rowsFromTop * pitch,
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

  // Last known-good cell, ridden out on through unusable readings.
  const sensorHold = { grid: null, world: null };

  // --- Sensors offline -----------------------------------------------------------
  // Whether the rig has gone quiet: for each node, the server's stamp on its
  // latest message (last_seen) and when that stamp last changed. A node with
  // no stamp counts as heard on every frame while it is online.
  const messageStamp = [null, null, null];
  const messageAt = [-Infinity, -Infinity, -Infinity];

  // Neither node has sent anything for tuning.offlineMs, or the server says
  // both are offline: the rig is down, which is not the player leaving. Both
  // nodes' messages are noted on every call (map, not every(), which would
  // stop at the first node still sending).
  function rigIsOffline(list, now) {
    const quiet = [LEFT_SENSOR, RIGHT_SENSOR].map((slot) => {
      const node = list[slot];
      if (!node || !node.online || !node.latest) return true;
      const stamp = node.last_seen !== undefined ? node.last_seen : null;
      if (stamp === null || stamp !== messageStamp[slot]) messageAt[slot] = now;
      messageStamp[slot] = stamp;
      return now - messageAt[slot] > tuning.offlineMs;
    });
    return quiet.every(Boolean);
  }

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

  // The sensors' cursor over a hole scores, as the mouse's does - unless the
  // phone pad has the cursor, whose own hover scores instead.
  function hoverFromSensors(canvas, point) {
    if (!gameState.remoteActive) window.handleGameHover(canvas, point.x, point.y);
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

    // The rig has gone quiet: say so, rather than ride out its last readings.
    if (rigIsOffline(Array.isArray(orderedNodes) ? orderedNodes : [], now)) {
      sensorHold.grid = null;
      sensorHold.world = null;
      gameState.sensor = { ...fix, status: "offline", gx: null, gy: null, held: false, heldFor: badReadingStreak };
      gameState.cursor = { x: null, y: null, inBounds: false };
      return;
    }

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
      gameState.sensor = {
        ...fix, gx: stable.gx, gy: stable.gy,
        rawGx: grid.gx, rawGy: grid.gy,
        calibrated: grid.calibrated, held: false, heldFor: 0,
        xCm: world.x, yCm: world.y, resolved: world.resolved,
      };
      const point = moveCursor(canvas, world, cell.gx, dt);
      if (point) hoverFromSensors(canvas, point);
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

    // Ride out unusable readings on the last known-good square, for as long as
    // they last: rejects are normal for ultrasonics and must not throw the
    // player out of the game. Only both nodes being lost (Out of bounds,
    // bothNodesLost(); that wait was the grace) ends it, or the rig going
    // offline (above).
    if (sensorHold.grid && !fix.nobodyFound) {
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
      if (point) hoverFromSensors(canvas, point);
      return;
    }

    // No square to ride out on: Out of bounds if nobody is found, otherwise
    // the round just waits for the first position, with no message.
    sensorHold.grid = null;
    sensorHold.world = null;
    gameState.sensor = {
      ...fix,
      status: fix.nobodyFound ? "out-of-bounds" : "no-signal",
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
    // The server only recomputes when a reading arrives, so once the rig has
    // gone quiet its last coordinate would sit on screen forever. Say
    // Sensors offline instead, which also pauses the round.
    const list = Array.isArray(orderedNodes) ? orderedNodes : [];
    if (rigIsOffline(list, performance.now())) {
      gameState.sensor = { ...emptySensorState(), status: "offline" };
      gameState.cursor = { x: null, y: null, inBounds: false };
      return;
    }
    const c = serverCoordinate;

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
    hoverFromSensors(canvas, point);
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
  // While the nodes learn the room, their echoes are the furniture's, not the
  // player's, so the round waits for that too. Never while the phone pad
  // places the player.
  function isSensorBlocked() {
    return gameState.inputMode === "sensor" && !gameState.remoteActive &&
      (gameState.sensor.status !== "ok" || roomStatus === "learning");
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

  // Top-right, under the level panel (and clear of the legend below it).
  function getPulsesButtonLayout(canvas) {
    const width = canvas.clientWidth || canvas.width;
    const w = 170;
    return { x: width - 12 - w, y: 60, width: w, height: 36 };
  }

  function pulsesLabel() {
    return settings.pulsesPerAngle > 1 ? `Pulses: ${settings.pulsesPerAngle}` : "Pulses: Off";
  }

  window.getGamePulsesButtonAtPoint = function getGamePulsesButtonAtPoint(canvas, x, y) {
    if (gameState.status !== "playing") return null;
    return pointInRect(x, y, getPulsesButtonLayout(canvas)) ? { type: "pulses" } : null;
  };

  // Off -> 2 -> 3 -> off.
  window.cycleGamePulses = function cycleGamePulses() {
    const index = PULSE_COUNT_OPTIONS.indexOf(settings.pulsesPerAngle);
    settings.pulsesPerAngle = PULSE_COUNT_OPTIONS[(index + 1) % PULSE_COUNT_OPTIONS.length];
    console.info(`[scan] ${pulsesLabel()}`);
    return settings.pulsesPerAngle;
  };

  // Room button: right under the Pulses button. Pressing it has the nodes learn
  // the empty room (canvas.js sends nodes:room); it shows their progress.
  function getRoomButtonLayout(canvas) {
    const pulses = getPulsesButtonLayout(canvas);
    return { x: pulses.x, y: pulses.y + pulses.height + 8, width: pulses.width, height: pulses.height };
  }

  function roomLabel() {
    if (roomStatus === "learning") return "Learning room";
    if (roomStatus === "learned") return "Room: learned";
    return "Learn room";
  }

  window.getGameRoomButtonAtPoint = function getGameRoomButtonAtPoint(canvas, x, y) {
    if (gameState.status !== "playing") return null;
    return pointInRect(x, y, getRoomButtonLayout(canvas)) ? { type: "room" } : null;
  };

  // Amber while the nodes are learning the room, like Pulses while it is on.
  function drawRoomButton(ctx, canvas) {
    const room = getRoomButtonLayout(canvas);
    const learning = roomStatus === "learning";
    if (learning) {
      ctx.fillStyle = "#f59e0b";
      ctx.beginPath();
      ctx.roundRect(room.x, room.y, room.width, room.height, 10);
      ctx.fill();
    } else {
      drawHudPanel(ctx, room.x, room.y, room.width, room.height, 10);
    }
    ctx.textAlign = "center";
    ctx.fillStyle = learning ? "#13131c" : "#f4f4f5";
    ctx.font = "bold 15px monospace";
    ctx.fillText(roomLabel(), room.x + room.width / 2, room.y + room.height / 2 + 5);
  }

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

  // Banner shown instead of the cursor: Out of bounds only when both nodes
  // are lost over their last tuning.lostReadings readings (bothNodesLost();
  // Aaron, 5 Oct), and Sensors offline when the rig has gone quiet. Waiting for a
  // first position shows nothing. The full-screen red alert is reserved for
  // the too-close case and is handled by canvas.js switching screens, so it
  // never appears here.
  function renderSensorStatusOverlay(ctx, canvas) {
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const status = gameState.sensor.status;

    let message = null;
    let detail = "";
    if (roomStatus === "learning") {
      message = "Learning the room";
      detail = "Keep the play area clear until the Room button says learned";
    } else if (status === "out-of-bounds") {
      message = "Out of bounds";
      detail = "Nobody detected - step into the play area";
    } else if (status === "offline") {
      message = "Sensors offline";
      detail = "No readings from either node - check their power and Wi-Fi";
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
  // The ways of placing the player, as the sensor panel and the control panel
  // show them.
  const METHOD_STYLES = {
    dyn: { label: "Dynamic", short: "DYN", colour: "#a3e635" },
    los: { label: "Line of sight", short: "LOS", colour: "#22d3ee" },
    tri: { label: "Trilateration", short: "TRI", colour: "#e879f9" },
    avg: { label: "Average", short: "AVG", colour: "#f8fafc" },
  };
  // What the control panel's Dynamic button says when one of its rules places
  // the player (dynamicRule()): a far corner, the column lock, or a lone
  // confident node.
  const DYNAMIC_RULE_SHORT = {
    "corner-left": "A1", "corner-right": "A3",
    centre: "MID", "lock-left": "COL L", "lock-right": "COL R",
    left: "L", right: "R",
  };
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

      // Green = echoing now, amber = coasting on a held value, blue = waiting
      // for its scanning turn (its last reading is old), red = nothing.
      const sinceHeard = sensor.heardMsAgo ? sensor.heardMsAgo[i] : 0;
      let dot = "#ef4444";
      if (echoing && sinceHeard > SENSOR_HOLD_MS) dot = "#60a5fa";
      else if (echoing) dot = "#22c55e";
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
        `x ${formatCm(sensor.xCm)}  y ${formatCm(sensor.yCm)} cm${from}${coarse ? "  column centre" : ""}` +
          (sensor.offBoard ? "  off board: edge" : ""),
        x + 16,
        posY
      );
    } else {
      ctx.fillStyle = "#63736f";
      ctx.fillText("x --  y -- cm", x + 16, posY);
    }

    // Every method's position side by side; the one placing the player (the
    // one Dynamic follows, with Dynamic on) is bold.
    const compareY = posY + 18;
    const fixes = sensor.fixes || {};
    DYNAMIC_METHODS.forEach((method, k) => {
      const style = METHOD_STYLES[method];
      const fix = fixes[method];
      const inUse = method === sensor.placedBy;
      ctx.font = `${inUse ? "bold " : ""}11px monospace`;
      ctx.fillStyle = fix ? style.colour : "#63736f";
      const where = fix ? `${fix.x.toFixed(0)},${fix.y.toFixed(0)}` : "--";
      ctx.fillText(`${style.short} ${where}`, x + 16 + k * 118, compareY);
    });

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
        sensor.held ? `${label}  HELD ${sensor.heldFor}` : label,
        x + 16,
        fixY
      );
    } else {
      ctx.fillStyle = "#ef4444";
      ctx.fillText(String(status).toUpperCase().replace(/-/g, " "), x + 16, fixY);
    }

    ctx.textAlign = "start";
  }

  // --- HUD layout ------------------------------------------------------------
  // Bottom-left: in sensor mode the sensor panel sits in the corner (the mouse
  // needs no input box), and stays there while the phone pad has the cursor.
  // The position switch is on the control panel only. LIVE STATS
  // fills the room left between that and the score panel, showing as many
  // rows as fit. LIVE DATA (box plot and bar charts) sits under the How to
  // Play legend.

  function renderHud(ctx, canvas) {
    const height = canvas.clientHeight || canvas.height;
    const view = window.GameStatsView || null;

    const score = getScorePanelRect(canvas);
    const minTop = score.y + score.h + HUD_GAP;
    let stackTop = height - HUD_EDGE;

    if (gameState.inputMode === "sensor") {
      stackTop -= SENSOR_PANEL_H;
      renderSensorPanel(ctx, HUD_EDGE, stackTop);
    }

    const stats = roundStats();
    if (!view || !stats) return;
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

    // Pulses button: multi-pulse on the scanner nodes, amber while on.
    if (gameState.status === "playing") {
      const pulses = getPulsesButtonLayout(canvas);
      const pulsesOn = settings.pulsesPerAngle > 1;
      if (pulsesOn) {
        ctx.fillStyle = "#f59e0b";
        ctx.beginPath();
        ctx.roundRect(pulses.x, pulses.y, pulses.width, pulses.height, 10);
        ctx.fill();
      } else {
        drawHudPanel(ctx, pulses.x, pulses.y, pulses.width, pulses.height, 10);
      }
      ctx.textAlign = "center";
      ctx.fillStyle = pulsesOn ? "#13131c" : "#f4f4f5";
      ctx.font = "bold 15px monospace";
      ctx.fillText(pulsesLabel(), pulses.x + pulses.width / 2, pulses.y + pulses.height / 2 + 5);
      drawRoomButton(ctx, canvas);
    }

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

    // The phone pad places the player over whatever the sensors say.
    if (gameState.inputMode === "sensor" && !gameState.remoteActive && gameState.status === "playing") {
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
