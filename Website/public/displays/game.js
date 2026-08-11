// game.js - Whack-a-mole game state, logic, and rendering.
//
// This module owns the game's internal state and exposes a small API on
// `window` that canvas.js drives:

//   window.resetGame()                         - start/restart a round
//   window.updateGame(timestampMs)              - advance game state, call every frame
//   window.setGameCursor(canvas, x, y)          - feed in the latest input coordinate
//   window.handleGameClick(canvas, x, y)        - register a hit attempt
//   window.getGameOverButtonAtPoint(canvas,x,y) - hit-test Restart / Return to Start
//   window.renderGame(ctx, canvas, nodes)              - draw the current frame
//   window.getGameState()                       - read-only peek at state (score/level/etc)



//Bugs
// - level select features is kinda broken it
// works fine when you do not hit moles but when
// you hit moles the mole timer gets overriden




(function () {
  const GAME_DURATION_MS = 60000; // overall round length shown as the countdown
  const HITS_PER_LEVEL = 5; // score needed to advance a level
  const BASE_MOLE_MS = 3000; // visible duration at level 1
  const MIN_MOLE_MS = 150; // floor so higher levels stay clickable
  const MAX_SELECTABLE_LEVEL = 10; // highest level selectable from the HUD
  const MIN_SPAWN_DELAY_MS = 250; // gap before a new mole appears
  const MAX_SPAWN_DELAY_MS = 700;
  const HIT_FEEDBACK_MS = 200; // how long the "hit" flash lasts
  const SUPER_MOLE_POINTS = 3; // score awarded for hitting a super mole
  const BOMB_PENALTY = 3; // score lost for hitting a bomb
  const BOMB_SPAWN_CHANCE = 0.2; // share of spawns that are bombs
  const SUPER_SPAWN_CHANCE = 0.15; // share of spawns that are super moles

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
    status: "idle", // "idle" | "playing" | "gameover"
    score: 0,
    level: 1,
    selectedLevel: 1,
    remainingMs: GAME_DURATION_MS,
    lastTickTime: null,
    activeHole: -1, // -1 means no mole currently up
    moleType: "mole", // "mole" | "bomb" | "super"
    moleSpawnedAt: 0,
    moleDurationMs: BASE_MOLE_MS,
    nextSpawnAt: 0,
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
    const scaled = BASE_MOLE_MS / Math.pow(level, 1.6);
    return Math.max(MIN_MOLE_MS, Math.floor(scaled));
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
    gameState.level = gameState.selectedLevel;
    gameState.moleDurationMs = computeMoleDuration(gameState.level);
    gameState.remainingMs = GAME_DURATION_MS;
    gameState.lastTickTime = null;
    gameState.activeHole = -1;
    gameState.moleType = "mole";
    gameState.moleSpawnedAt = 0;
    gameState.moleDurationMs = BASE_MOLE_MS;
    gameState.nextSpawnAt = 0;
    gameState.hitFlash = { hole: -1, until: 0, type: null };
    gameState.cursor = { x: null, y: null, inBounds: true };
  };

  window.getGameState = function getGameState() {
    return gameState;
  };

  window.setGameLevel = function setGameLevel(level) {
    const nextLevel = Math.max(1, Math.min(MAX_SELECTABLE_LEVEL, level));
    gameState.selectedLevel = nextLevel;
    gameState.level = Math.max(nextLevel, computeLevel(gameState.score));
    gameState.moleDurationMs = computeMoleDuration(gameState.level);
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
      gameState.activeHole = -1;
      gameState.nextSpawnAt = now + randomBetween(MIN_SPAWN_DELAY_MS, MAX_SPAWN_DELAY_MS);
    }

    gameState.level = Math.max(gameState.selectedLevel, computeLevel(gameState.score));
    gameState.moleDurationMs = computeMoleDuration(gameState.level);

    // Spawn a mole if none is up and it's time (only one hole active at once).
    if (gameState.activeHole === -1 && now >= gameState.nextSpawnAt) {
      gameState.activeHole = pickRandomHole(-1);
      gameState.moleSpawnedAt = now;
      gameState.moleType = pickRandomMoleType();
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

    if (hitType === "bomb") {
      gameState.score = Math.max(0, gameState.score - BOMB_PENALTY);
    } else {
      gameState.score += hitType === "super" ? SUPER_MOLE_POINTS : 1;
    }

    gameState.hitFlash = { hole: holeIndex, until: now + HIT_FEEDBACK_MS, type: hitType };
    gameState.activeHole = -1;
    gameState.level = Math.max(gameState.selectedLevel, computeLevel(gameState.score));
    gameState.moleDurationMs = computeMoleDuration(gameState.level);
    gameState.nextSpawnAt = now + randomBetween(MIN_SPAWN_DELAY_MS, MAX_SPAWN_DELAY_MS);
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

  function getGameLevelLayout(canvas) {
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const buttonSize = 38;
    const gap = 8;
    const startX = width / 2 - ((buttonSize * 5 + gap * 4) / 2)-110;
    const y = Math.max(60, height * 0.08);

    return {
      buttons: Array.from({ length: MAX_SELECTABLE_LEVEL }, (_, index) => {
        const level = index + 1;
        return {
          level,
          x: startX + index * (buttonSize + gap),
          y,
          width: buttonSize,
          height: buttonSize,
        };
      }),
    };
  }

  window.getGameLevelButtonAtPoint = function getGameLevelButtonAtPoint(canvas, x, y) {
    const layout = getGameLevelLayout(canvas);
    const hit = layout.buttons.find((button) => pointInRect(x, y, button));
    return hit ? { type: "level", level: hit.level } : null;
  };

  window.getGameOverButtonAtPoint = function getGameOverButtonAtPoint(canvas, x, y) {
    if (gameState.status !== "gameover") return null;
    const layout = getGameOverLayout(canvas);

    if (pointInRect(x, y, layout.restartButton)) return { type: "restart" };
    if (pointInRect(x, y, layout.returnButton)) return { type: "return" };
    return null;
  };

  function renderGameOverOverlay(ctx, canvas) {
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const centerX = width / 2;

    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, width, height);

    ctx.textAlign = "center";
    ctx.fillStyle = "#cdd6f4";
    ctx.font = "bold 40px monospace";
    ctx.fillText("Game Over", centerX, height / 2 - 60);

    ctx.font = "20px monospace";
    ctx.fillText(`Score: ${gameState.score}   Level reached: ${gameState.level}`, centerX, height / 2 - 10);

    const layout = getGameOverLayout(canvas);

    ctx.fillStyle = "#22c55e";
    ctx.beginPath();
    ctx.roundRect(layout.restartButton.x, layout.restartButton.y, layout.restartButton.width, layout.restartButton.height, 8);
    ctx.fill();
    ctx.fillStyle = "#13131c";
    ctx.font = "bold 16px monospace";
    ctx.fillText("Restart", layout.restartButton.x + layout.restartButton.width / 2, layout.restartButton.y + layout.restartButton.height / 2 + 6);

    ctx.fillStyle = "#475569";
    ctx.beginPath();
    ctx.roundRect(layout.returnButton.x, layout.returnButton.y, layout.returnButton.width, layout.returnButton.height, 8);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText("Return to Start", layout.returnButton.x + layout.returnButton.width / 2, layout.returnButton.y + layout.returnButton.height / 2 + 6);

    ctx.textAlign = "start";
  }

  window.renderGame = function renderGame(ctx, canvas, nodes) {

    console.log(nodes)
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;

    ctx.fillStyle = "#df8923";
    ctx.fillRect(0, 0, width, height);

    // HUD: score (left), timer (center), level (right)
    ctx.textAlign = "left";
    ctx.fillStyle = "#cdd6f4";
    ctx.font = "bold 20px monospace";
    ctx.fillText(`Score: ${gameState.score}`, 20, 36);

    ctx.textAlign = "right";
    ctx.fillText(`Level: ${gameState.level}`, width - 20, 36);

    const levelLayout = getGameLevelLayout(canvas);
    levelLayout.buttons.forEach((button) => {
      const isSelected = button.level === gameState.selectedLevel;
      ctx.fillStyle = isSelected ? "#22c55e" : "#475569";
      ctx.beginPath();
      ctx.roundRect(button.x, button.y, button.width, button.height, 8);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.font = "bold 14px monospace";
      ctx.fillText(`${button.level}`, button.x + button.width / 2, button.y + button.height / 2 + 5);
    });
    ctx.textAlign = "center";
    const secondsLeft = Math.ceil(gameState.remainingMs / 1000);
    ctx.fillStyle = secondsLeft <= 10 ? "#ef4444" : "#cdd6f4";
    ctx.font = "bold 24px monospace";
    ctx.fillText(`${secondsLeft}s`, width / 2, 40);

    // Grid + moles
    const layout = window.getGameGridLayout(canvas);
    const now = performance.now();
    const holeImg = moleImages.hole;

    layout.holes.forEach((hole) => {
      const centerX = hole.x + hole.size / 2;
      const groundH = hole.size * 0.34;
      const groundTopY = hole.y + hole.size - groundH;

      if (isImageReady(holeImg)) {
        const groundW = groundH * (holeImg.width / holeImg.height);
        ctx.drawImage(holeImg, centerX - groundW / 2, groundTopY, groundW, groundH);
      } else {
        ctx.fillStyle = "#3b2a1a";
        ctx.beginPath();
        ctx.roundRect(hole.x, hole.y, hole.size, hole.size, 10);
        ctx.fill();
        ctx.strokeStyle = "#585b70";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      const isFlashing = gameState.hitFlash.hole === hole.index && now < gameState.hitFlash.until;
      if (isFlashing) {
        ctx.fillStyle = gameState.hitFlash.type === "bomb" ? "rgba(239, 68, 68, 0.4)" : "rgba(34, 197, 94, 0.35)";
        ctx.beginPath();
        ctx.roundRect(hole.x, hole.y, hole.size, hole.size, 10);
        ctx.fill();
      }

      if (hole.index === gameState.activeHole) {
        const type = gameState.moleType;
        const img = moleImages[type === "bomb" ? "bomb" : type === "super" ? "super_mole" : "mole"];

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
      } else if (isFlashing && gameState.hitFlash.type !== "bomb") {
        const img = moleImages[gameState.hitFlash.type === "super" ? "dead_super_mole" : "dead_mole"];
        if (isImageReady(img)) {
          const height = hole.size * 0.62;
          drawImageCentered(ctx, img, centerX, groundTopY - height * 0.35, height);
        }
      }
    });

    // Cursor from click / external (flask) coordinate
    if (gameState.cursor.x !== null) {
      if (gameState.cursor.inBounds) {
        ctx.strokeStyle = "#facc15";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(gameState.cursor.x, gameState.cursor.y, 10, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = "#ef4444";
        ctx.font = "bold 16px monospace";
        ctx.textAlign = "center";
        ctx.fillText("Out of bounds", width / 2, height - 30);
      }
    }

    if (gameState.status === "gameover") {
      renderGameOverOverlay(ctx, canvas);
    }

    ctx.textAlign = "start";
  };
})();
