// game.js - Whack-a-mole game state, logic, and rendering.
//
// This module owns the game's internal state and exposes a small API on
// `window` that canvas.js drives:

//   window.resetGame()                         - start/restart a round
//   window.pauseGame() / window.resumeGame()    - pause/resume mid-round
//   window.updateGame(timestampMs)              - advance game state, call every frame
//   window.setGameCursor(canvas, x, y)          - feed in the latest input coordinate
//   window.handleGameClick(canvas, x, y)        - register a hit attempt
//   window.getGamePauseButtonAtPoint(canvas,x,y)- hit-test the pause icon
//   window.getPauseMenuButtonAtPoint(canvas,x,y)- hit-test Resume / Restart / Main Menu
//   window.getGameOverButtonAtPoint(canvas,x,y) - hit-test Restart / Return to Start
//   window.renderGame(ctx, canvas, nodes)              - draw the current frame
//   window.getGameState()                       - read-only peek at state (score/level/etc)

(function () {
  const GAME_DURATION_MS = 60000; // overall round length shown as the countdown
  const HITS_PER_LEVEL = 10; // score needed to advance a level
  const BASE_MOLE_MS = 3000; // visible duration at level 1
  const MIN_MOLE_MS = 500; // floor so even high levels stay realistically hittable
  const MOLE_DURATION_DECAY = 0.85; // gentle falloff (was 1.6) so late levels don't become unplayable
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

  // Adjustable via the Options screen; read fresh at the start of each round.
  const settings = {
    durationMs: GAME_DURATION_MS,
    startingLives: DEFAULT_LIVES,
    soundEnabled: true,
  };

  window.getGameSettings = function getGameSettings() {
    return { ...settings };
  };

  window.setGameSettings = function setGameSettings(partial) {
    Object.assign(settings, partial);
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

  const gameState = {
    status: "idle", // "idle" | "playing" | "paused" | "gameover"
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

  function computeLevel(score) {
    return 1 + Math.floor(score / HITS_PER_LEVEL);
  }

  function computeMoleDuration(level) {
    const scaled = BASE_MOLE_MS / Math.pow(level, MOLE_DURATION_DECAY);
    return Math.max(MIN_MOLE_MS, Math.floor(scaled));
  }

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
    if (roll < BOMB_SPAWN_CHANCE) return "bomb";
    if (roll < BOMB_SPAWN_CHANCE + SUPER_SPAWN_CHANCE) return "super";
    return "mole";
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
    gameState.moleDurationMs = BASE_MOLE_MS;
    gameState.nextSpawnAt = 0;
    gameState.hitFlash = { hole: -1, until: 0, type: null };
    gameState.cursor = { x: null, y: null, inBounds: true };
  };

  window.getGameState = function getGameState() {
    return gameState;
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
  window.updateGame = function updateGame(now) {
    if (gameState.status !== "playing") return;

    if (gameState.lastTickTime === null) {
      gameState.lastTickTime = now;
      gameState.nextSpawnAt = now + randomBetween(MIN_SPAWN_DELAY_MS, MAX_SPAWN_DELAY_MS);
    }

    const elapsed = now - gameState.lastTickTime;
    gameState.lastTickTime = now;
    gameState.remainingMs -= elapsed;

    if (gameState.remainingMs <= 0) {
      gameState.remainingMs = 0;
      gameState.status = "gameover";
      gameState.activeHole = -1;
      return;
    }

    // Mole timed out without being hit -> remove it and schedule the next one.
    if (gameState.activeHole !== -1 && now - gameState.moleSpawnedAt >= gameState.moleDurationMs) {
      const missedMole = gameState.moleType !== "bomb"; // letting a bomb expire is fine, missing a mole costs a life
      gameState.activeHole = -1;
      gameState.moleWounded = false;
      gameState.nextSpawnAt = now + randomBetween(MIN_SPAWN_DELAY_MS, MAX_SPAWN_DELAY_MS);

      if (missedMole) {
        gameState.lives = Math.max(0, gameState.lives - 1);
        if (gameState.lives <= 0) {
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

  // Feed in the latest input coordinate (mouse, touch, or the external
  // flask-server-supplied coordinate). Tracks in/out-of-bounds for display.
  window.setGameCursor = function setGameCursor(canvas, x, y) {
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
      gameState.lives = Math.max(0, gameState.lives - 1);
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

    if (gameState.lives <= 0) {
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

  
  let prev = [0, 0, false]

  //Input: Nodes array
  //Output: Santised x, y corrdinate and too close flag for the alert, i.e. [int x, int y, bool alert]
  function triangulate(nodes) {
    distances = [0, 0, 0]
    // console.log(nodes)

    //Parse data
    for (i = 1; i <= 3; i++) {
      let cur = nodes.get(i)
      if (cur != null) {
        data = JSON.parse(cur.latest)
        dist = data.avg

        if (i == 1) {
          distances[0] = dist
        } else {
          if (i == 2) {
            distances[1] = dist
          } else {
            distances[2] = dist
          }
        }
      }
    }

    const maxDist = 210
    const minDist = 2

    //Find outliers
    let count = 0
    for (let i = 0; i < 3; i++){
      let cur = distances[i];
      if (cur < minDist || cur > maxDist) {
        distances[i] = 99999
        count++
      }
    }

    if (count == 3) {
      return prev
    }

    let x = 0
    let y = 0

    let i = 0
    let min = 0
    let minInx = 0
    while (i < 3) {
      let val = distances[i]
      if (val < min) {
        min = val
        minInx = i
      }
      i++
    }

    x = minInx
    y = (min - 10) / 50

    let tooClose = false
    
    if (min <= 10) {
      tooClose = true
    }

    let output = 
    prev = output

    prev[0] = x
    prev[1] = y
    prev[2] = tooClose

    return [x, y, tooClose]
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
    if (gameState.lives <= 0) {
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

  window.renderGame = function renderGame(ctx, canvas, nodes) {
    // console.log(nodes)

    locationArr = triangulate(nodes);

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
    ctx.fillText("♥".repeat(Math.max(0, gameState.lives)), scorePanel.x + 16, scorePanel.y + scoreFontSize + livesFontSize + 22);

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
    ctx.fillStyle = secondsLeft <= 10 ? "#ef4444" : "#f4f4f5";
    ctx.font = `bold ${timerFontSize}px monospace`;
    ctx.fillText(`${secondsLeft}s`, width / 2, 8 + timerPanelH / 2 + timerFontSize * 0.35);

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
      { color: "#8b5e3c", title: "Mole", lines: ["Whack it for", "+1 point."] },
      { color: "#eab308", title: "Hat Mole", lines: ["2 hits to defeat,", `worth +${SUPER_MOLE_POINTS} points.`] },
      { color: "#ef4444", title: "Bomb", lines: [`Avoid! -${BOMB_PENALTY} points`, "and a lost life."] },
    ];
    const legendEntryHeight = 74;
    const legendHeaderHeight = 40;
    const legendHeight = legendHeaderHeight + legendEntries.length * legendEntryHeight + 14;
    drawHudPanel(ctx, legendX, legendY, legendWidth, legendHeight, 14);

    ctx.textAlign = "left";
    ctx.fillStyle = "#f4f4f5";
    ctx.font = "bold 16px monospace";
    ctx.fillText("How to Play", legendX + 16, legendY + 26);

    legendEntries.forEach((entry, index) => {
      const entryY = legendY + legendHeaderHeight + index * legendEntryHeight;
      ctx.fillStyle = entry.color;
      ctx.beginPath();
      ctx.roundRect(legendX + 16, entryY, 18, 18, 5);
      ctx.fill();

      ctx.fillStyle = "#f4f4f5";
      ctx.font = "bold 15px monospace";
      ctx.fillText(entry.title, legendX + 44, entryY + 14);

      ctx.fillStyle = "#9298aa";
      ctx.font = "12px monospace";
      entry.lines.forEach((line, lineIndex) => {
        ctx.fillText(line, legendX + 16, entryY + 34 + lineIndex * 15);
      });
    });

    // Cursor from click / external (flask) coordinate
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
      } else {
        drawHudPanel(ctx, width / 2 - 100, height - 58, 200, 40, 10);
        ctx.fillStyle = "#ef4444";
        ctx.font = "bold 16px monospace";
        ctx.textAlign = "center";
        ctx.fillText("Out of bounds", width / 2, height - 32);
      }
    }

    if (gameState.status === "paused") {
      renderPauseOverlay(ctx, canvas);
    } else if (gameState.status === "gameover") {
      renderGameOverOverlay(ctx, canvas);
    }

    ctx.textAlign = "start";
  };
})();
