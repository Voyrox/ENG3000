// calibrate.js - Guided sensor assignment.
//
// Node IDs are handed out by the server in connection order, which tells us
// nothing about where a sensor physically sits. This screen establishes that
// mapping directly: the operator holds a hand in front of each sensor in turn,
// and whichever node's distance collapses is assigned to that slot.
//
// The rig has two sensors now, LEFT and RIGHT; there is no centre sensor, so only
// those two are identified. The result keeps the [left, centre, right] ordering
// everything downstream relies on, with the centre slot always empty -
// readSensorCoordinate() turns a slot index straight into a grid column, so if
// this mapping is wrong the whole board is mirrored or scrambled.
//
// This screen is the whole calibration. While it is up - through both steps,
// LEFT then RIGHT - both servos are held still at 90 degrees (canvas.js asks
// the server, which sends AIM 90 to each node), so the operator can aim the
// nodes straight out into the play area by hand. Each live-readings row shows
// the angle the node reports, so a servo that is not holding stands out.
// Start Game appears once both nodes are identified; leaving the screen lets
// the nodes scan again.
//
// API on `window`:
//   window.updateSensorAssignment(nodes, now) - run detection, call on each update
//   window.getSensorAssignment()              - [leftId, null, rightId]
//   window.isSensorAssignmentComplete()
//   window.resetSensorAssignment()
//   window.renderCalibrate(ctx, canvas, nodes)
//   window.getCalibrateButtonAtPoint(canvas, x, y)

(function () {
  // column: the slot's index in [left, centre, right]; the centre has no sensor.
  const SLOTS = [
    { key: "left", label: "LEFT", column: 0 },
    { key: "right", label: "RIGHT", column: 2 },
  ];
  const COLUMN_COUNT = 3;

  // A hand held deliberately in front of a sensor reads much closer than the
  // room behind it.
  const HAND_DISTANCE_CM = 30;
  // ...and must be clearly nearer than any other unassigned sensor, so a hand
  // in the middle cannot claim two slots at once.
  const HAND_MARGIN_CM = 12;
  // Hold steady this long to confirm. Long enough that a noise spike cannot
  // assign a slot, short enough not to be tiring.
  const HAND_DWELL_MS = 700;
  // Where the servos are held while this screen is up (the server's AIM_ANGLE_DEG).
  const AIM_ANGLE_DEG = 90;


  const state = {
    slots: { left: null, right: null },
    activeIndex: 0,
    candidateId: null,
    dwellStartedAt: 0,
    dwellProgress: 0, // 0..1, drives the progress bar
  };

  function activeSlot() {
    return SLOTS[state.activeIndex] || null;
  }

  function assignedIds() {
    return SLOTS.map((slot) => state.slots[slot.key]);
  }

  function isComplete() {
    return assignedIds().every((id) => id !== null);
  }

  function clearDwell() {
    state.candidateId = null;
    state.dwellStartedAt = 0;
    state.dwellProgress = 0;
  }

  // By column: [leftId, null, rightId]. The centre stays null - there is no
  // centre sensor - so a slot index is still the grid column downstream.
  window.getSensorAssignment = function getSensorAssignment() {
    const byColumn = new Array(COLUMN_COUNT).fill(null);
    SLOTS.forEach((slot) => {
      byColumn[slot.column] = state.slots[slot.key];
    });
    return byColumn;
  };

  window.isSensorAssignmentComplete = isComplete;

  window.resetSensorAssignment = function resetSensorAssignment() {
    SLOTS.forEach((slot) => {
      state.slots[slot.key] = null;
    });
    state.activeIndex = 0;
    clearDwell();
  };

  window.getSensorAssignmentState = function getSensorAssignmentState() {
    return {
      slots: { ...state.slots },
      activeKey: activeSlot() ? activeSlot().key : null,
      dwellProgress: state.dwellProgress,
      candidateId: state.candidateId,
      complete: isComplete(),
    };
  };

  function distanceFor(node) {
    if (!window.readNodeDistance) return null;
    return window.readNodeDistance(node);
  }

  // The servo angle the node reported with its latest reading, or null.
  function angleFor(node) {
    if (!window.readNodeScan) return null;
    return window.readNodeScan(node).angle;
  }

  // Drops any slot whose node has disappeared, so unplugging a sensor reopens
  // its slot rather than leaving a stale ID behind.
  function pruneMissing(nodes) {
    const liveIds = new Set(nodes.map((node) => node.id));
    let dropped = false;

    SLOTS.forEach((slot) => {
      const id = state.slots[slot.key];
      if (id !== null && !liveIds.has(id)) {
        state.slots[slot.key] = null;
        dropped = true;
      }
    });

    if (dropped) {
      const nextIndex = SLOTS.findIndex((slot) => state.slots[slot.key] === null);
      state.activeIndex = nextIndex === -1 ? SLOTS.length : nextIndex;
      clearDwell();
    }
  }

  // Runs the detection for the active slot. Call whenever fresh node data
  // arrives; `now` defaults to the current time.
  window.updateSensorAssignment = function updateSensorAssignment(nodes = [], now) {
    const time = Number.isFinite(now) ? now : performance.now();
    pruneMissing(nodes);

    const slot = activeSlot();
    if (!slot) {
      clearDwell();
      return;
    }

    const taken = new Set(assignedIds().filter((id) => id !== null));

    // Rank the still-unassigned sensors by how close something is to them.
    const candidates = nodes
      .filter((node) => !taken.has(node.id))
      .map((node) => ({ id: node.id, distance: distanceFor(node) }))
      .filter((entry) => entry.distance !== null)
      .sort((a, b) => a.distance - b.distance);

    const nearest = candidates[0];
    const runnerUp = candidates[1];

    const clearWinner =
      nearest &&
      nearest.distance <= HAND_DISTANCE_CM &&
      (!runnerUp || runnerUp.distance - nearest.distance >= HAND_MARGIN_CM);

    if (!clearWinner) {
      clearDwell();
      return;
    }

    // Restart the dwell whenever the hand moves to a different sensor.
    if (state.candidateId !== nearest.id) {
      state.candidateId = nearest.id;
      state.dwellStartedAt = time;
    }

    const elapsed = time - state.dwellStartedAt;
    state.dwellProgress = Math.max(0, Math.min(1, elapsed / HAND_DWELL_MS));

    if (elapsed >= HAND_DWELL_MS) {
      state.slots[slot.key] = nearest.id;
      state.activeIndex += 1;
      clearDwell();
    }
  };

  // --- Layout ---------------------------------------------------------------

  window.getCalibrateLayout = function getCalibrateLayout(canvas) {
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const centerX = width / 2;

    const cardW = Math.min(210, Math.max(140, width * 0.18));
    const cardH = 132;
    const gap = 18;
    const rowW = cardW * SLOTS.length + gap * (SLOTS.length - 1);
    // Title and instructions clear of the top button row; the cards clear of
    // the last instruction line (the servo hold, at titleY + 96).
    const titleY = Math.max(90, height * 0.12);
    const cardY = Math.max(titleY + 120, height * 0.28);

    return {
      width,
      height,
      centerX,
      titleY,
      cardY,
      cardW,
      cardH,
      backButton: { type: "back", x: 16, y: 16, width: 80, height: 36, label: "◀ Back" },
      resetButton: { type: "reset", x: centerX - 50, y: 16, width: 100, height: 36, label: "Reset" },
      skipButton: { type: "skip", x: width - 96, y: 16, width: 80, height: 36, label: "Skip ▶" },
      // Live once both nodes are identified: calibration ends here.
      startButton: { type: "start", x: centerX - 110, y: height - 88, width: 220, height: 52, label: "Start Game" },
      cards: SLOTS.map((slot, index) => ({
        ...slot,
        x: centerX - rowW / 2 + index * (cardW + gap),
        y: cardY,
        width: cardW,
        height: cardH,
      })),
    };
  };

  function pointInRect(x, y, r) {
    return r && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
  }

  window.getCalibrateButtonAtPoint = function getCalibrateButtonAtPoint(canvas, x, y) {
    const layout = window.getCalibrateLayout(canvas);
    if (pointInRect(x, y, layout.backButton)) return { type: "back" };
    if (pointInRect(x, y, layout.resetButton)) return { type: "reset" };
    if (pointInRect(x, y, layout.skipButton)) return { type: "skip" };
    if (isComplete() && pointInRect(x, y, layout.startButton)) return { type: "start" };
    return null;
  };

  // --- Render ---------------------------------------------------------------

  function drawButton(ctx, btn) {
    ctx.fillStyle = "#475569";
    ctx.fillRect(btn.x, btn.y, btn.width, btn.height);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 14px monospace";
    ctx.textAlign = "center";
    ctx.fillText(btn.label, btn.x + btn.width / 2, btn.y + 24);
  }

  window.renderCalibrate = function renderCalibrate(ctx, canvas, nodes = []) {
    const layout = window.getCalibrateLayout(canvas);
    const { width, height, centerX, titleY } = layout;
    const slot = activeSlot();
    const complete = isComplete();

    ctx.fillStyle = "#13131c";
    ctx.fillRect(0, 0, width, height);

    [layout.backButton, layout.resetButton, layout.skipButton].forEach((btn) => drawButton(ctx, btn));

    // Title + instruction.
    ctx.textAlign = "center";
    ctx.fillStyle = "#f4f4f5";
    ctx.font = `bold ${Math.max(18, Math.min(32, width * 0.03))}px monospace`;
    ctx.fillText("Sensor Assignment", centerX, titleY);

    // The servos are held straight for as long as this screen is up, through
    // both steps (canvas.js sends the hold; the server passes AIM 90 to every node).
    ctx.fillStyle = "#7dd3fc";
    ctx.font = `bold ${Math.max(13, Math.min(18, width * 0.015))}px monospace`;
    ctx.fillText(
      `Servos held at ${AIM_ANGLE_DEG}° throughout - aim both nodes straight out into the play area`,
      centerX,
      titleY + 96
    );

    ctx.font = `${Math.max(15, Math.min(23, width * 0.02))}px monospace`;
    if (complete) {
      ctx.fillStyle = "#22c55e";
      ctx.fillText("Both sensors identified", centerX, titleY + 40);
    } else if (nodes.length === 0) {
      ctx.fillStyle = "#ef4444";
      ctx.fillText("Waiting for sensors to connect...", centerX, titleY + 40);
    } else {
      ctx.fillStyle = "#f59e0b";
      ctx.fillText(`Hold your hand in front of the ${slot.label} sensor`, centerX, titleY + 40);
    }

    ctx.fillStyle = "#63736f";
    ctx.font = `${Math.max(12, Math.min(15, width * 0.013))}px monospace`;
    ctx.fillText(
      complete ? "Aim both nodes straight, then press Start Game" : "Hold steady until the bar fills",
      centerX,
      titleY + 66
    );

    // Start Game: live once both nodes are identified, greyed out until then.
    const start = layout.startButton;
    ctx.fillStyle = complete ? "#22c55e" : "#2b2f3d";
    ctx.beginPath();
    ctx.roundRect(start.x, start.y, start.width, start.height, 10);
    ctx.fill();
    ctx.fillStyle = complete ? "#13131c" : "#63736f";
    ctx.font = "bold 16px monospace";
    ctx.fillText(start.label, start.x + start.width / 2, start.y + start.height / 2 + 6);

    // Slot cards
    layout.cards.forEach((card) => {
      const assignedId = state.slots[card.key];
      const isActive = !complete && slot && slot.key === card.key;

      let border = "#2b2f3d";
      if (assignedId !== null) border = "#22c55e";
      else if (isActive) border = "#f59e0b";

      ctx.fillStyle = "#1b2523";
      ctx.beginPath();
      ctx.roundRect(card.x, card.y, card.width, card.height, 10);
      ctx.fill();
      ctx.strokeStyle = border;
      ctx.lineWidth = isActive ? 3 : 1.5;
      ctx.stroke();

      ctx.textAlign = "center";
      ctx.fillStyle = border;
      ctx.font = "bold 15px monospace";
      ctx.fillText(card.label, card.x + card.width / 2, card.y + 30);

      if (assignedId !== null) {
        ctx.fillStyle = "#f4f4f5";
        ctx.font = "bold 30px monospace";
        ctx.fillText(`#${assignedId}`, card.x + card.width / 2, card.y + 76);

        const node = nodes.find((n) => n.id === assignedId);
        const distance = distanceFor(node);
        ctx.fillStyle = "#9298aa";
        ctx.font = "12px monospace";
        ctx.fillText(
          distance === null ? "no reading" : `${distance.toFixed(1)} cm`,
          card.x + card.width / 2,
          card.y + 102
        );
      } else if (isActive) {
        ctx.fillStyle = "#63736f";
        ctx.font = "13px monospace";
        ctx.fillText("waiting for hand", card.x + card.width / 2, card.y + 70);

        // Dwell progress
        const barW = card.width - 40;
        const barX = card.x + 20;
        const barY = card.y + 88;
        ctx.fillStyle = "#313244";
        ctx.beginPath();
        ctx.roundRect(barX, barY, barW, 10, 5);
        ctx.fill();

        if (state.dwellProgress > 0) {
          ctx.fillStyle = "#f59e0b";
          ctx.beginPath();
          ctx.roundRect(barX, barY, Math.max(6, barW * state.dwellProgress), 10, 5);
          ctx.fill();
        }
      } else {
        ctx.fillStyle = "#42425d";
        ctx.font = "13px monospace";
        ctx.fillText("not yet assigned", card.x + card.width / 2, card.y + 76);
      }
    });

    // Live node readings, so the operator can see the rig responding
    const listY = layout.cardY + layout.cardH + 52;
    ctx.textAlign = "center";
    ctx.fillStyle = "#63736f";
    ctx.font = "bold 11px monospace";
    ctx.fillText("LIVE READINGS", centerX, listY - 18);

    const sorted = nodes.slice().sort((a, b) => a.id - b.id);
    const rowW = Math.min(460, Math.max(320, width * 0.36));
    const rowX = centerX - rowW / 2;

    sorted.forEach((node, index) => {
      const rowY = listY + index * 30;
      const distance = distanceFor(node);
      const taken = assignedIds().includes(node.id);
      const isCandidate = state.candidateId === node.id;

      ctx.fillStyle = isCandidate ? "#2a2115" : "#1b2523";
      ctx.beginPath();
      ctx.roundRect(rowX, rowY, rowW, 24, 5);
      ctx.fill();

      ctx.textAlign = "left";
      ctx.font = "12px monospace";
      ctx.fillStyle = taken ? "#22c55e" : "#f4f4f5";
      ctx.fillText(`Node ${node.id}`, rowX + 12, rowY + 16);

      ctx.fillStyle = distance === null ? "#63736f" : "#cdd6f4";
      ctx.fillText(distance === null ? "no echo" : `${distance.toFixed(1)} cm`, rowX + 96, rowY + 16);

      // Nearer readings draw a longer bar, so a hand is obvious at a glance.
      if (distance !== null) {
        const barMax = rowW - 280;
        const closeness = Math.max(0, Math.min(1, 1 - distance / 100));
        ctx.fillStyle = distance <= HAND_DISTANCE_CM ? "#f59e0b" : "#3a3f52";
        ctx.beginPath();
        ctx.roundRect(rowX + 184, rowY + 8, Math.max(2, barMax * closeness), 8, 4);
        ctx.fill();
      }

      ctx.textAlign = "right";
      ctx.font = "12px monospace";
      // The angle the node says its servo is at: it should sit on 90 for the
      // whole screen, so anything else (amber) means it is not holding.
      const angle = angleFor(node);
      if (angle === null) {
        ctx.fillStyle = "#63736f";
        ctx.fillText("-", rowX + rowW - 56, rowY + 16);
      } else {
        ctx.fillStyle = Math.round(angle) === AIM_ANGLE_DEG ? "#22c55e" : "#f59e0b";
        ctx.fillText(`${Math.round(angle)}°`, rowX + rowW - 56, rowY + 16);
      }

      ctx.fillStyle = "#63736f";
      ctx.font = "11px monospace";
      const label = taken ? SLOTS.find((s) => state.slots[s.key] === node.id).label : "";
      ctx.fillText(label, rowX + rowW - 12, rowY + 16);
    });

    ctx.textAlign = "start";
  };

})();
