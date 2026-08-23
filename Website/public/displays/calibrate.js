// calibrate.js - Guided sensor assignment.
//
// Node IDs are handed out by the server in connection order, which tells us
// nothing about where a sensor physically sits. This screen establishes that
// mapping directly: the operator holds a hand in front of each sensor in turn,
// and whichever node's distance collapses is assigned to that slot.
//
// The result is the [left, centre, right] ordering everything downstream relies
// on - readSensorCoordinate() turns a slot index straight into a grid column,
// so if this mapping is wrong the whole board is mirrored or scrambled.
//
// API on `window`:
//   window.updateSensorAssignment(nodes, now) - run detection, call on each update
//   window.getSensorAssignment()              - [leftId, centreId, rightId]
//   window.isSensorAssignmentComplete()
//   window.resetSensorAssignment()
//   window.renderCalibrate(ctx, canvas, nodes)
//   window.getCalibrateButtonAtPoint(canvas, x, y)

(function () {
  const SLOTS = [
    { key: "left", label: "LEFT" },
    { key: "centre", label: "CENTRE" },
    { key: "right", label: "RIGHT" },
  ];

  // A hand held deliberately in front of a sensor reads much closer than the
  // room behind it.
  const HAND_DISTANCE_CM = 30;
  // ...and must be clearly nearer than any other unassigned sensor, so a hand
  // in the middle cannot claim two slots at once.
  const HAND_MARGIN_CM = 12;
  // Hold steady this long to confirm. Long enough that a noise spike cannot
  // assign a slot, short enough not to be tiring.
  const HAND_DWELL_MS = 700;

  window.CALIBRATE_AUTO_CONTINUE_NODES = 3;

  const state = {
    slots: { left: null, centre: null, right: null },
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

  window.getSensorAssignment = function getSensorAssignment() {
    return assignedIds();
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
    const rowW = cardW * 3 + gap * 2;
    const cardY = Math.max(180, height * 0.28);

    return {
      width,
      height,
      centerX,
      cardY,
      cardW,
      cardH,
      backButton: { type: "back", x: 16, y: 16, width: 80, height: 36, label: "◀ Back" },
      resetButton: { type: "reset", x: centerX - 50, y: 16, width: 100, height: 36, label: "Reset" },
      skipButton: { type: "skip", x: width - 96, y: 16, width: 80, height: 36, label: "Skip ▶" },
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
    const { width, height, centerX } = layout;
    const slot = activeSlot();
    const complete = isComplete();

    ctx.fillStyle = "#13131c";
    ctx.fillRect(0, 0, width, height);

    [layout.backButton, layout.resetButton, layout.skipButton].forEach((btn) => drawButton(ctx, btn));

    // Title + instruction
    const titleY = Math.max(54, height * 0.09);
    ctx.textAlign = "center";
    ctx.fillStyle = "#f4f4f5";
    ctx.font = `bold ${Math.max(18, Math.min(32, width * 0.03))}px monospace`;
    ctx.fillText("Sensor Assignment", centerX, titleY);

    ctx.font = `${Math.max(15, Math.min(23, width * 0.02))}px monospace`;
    if (complete) {
      ctx.fillStyle = "#22c55e";
      ctx.fillText("All three sensors identified", centerX, titleY + 40);
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
      complete ? "Continuing to corner calibration" : "Hold steady until the bar fills",
      centerX,
      titleY + 66
    );

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
    const rowW = Math.min(420, Math.max(280, width * 0.34));
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
        const barMax = rowW - 200;
        const closeness = Math.max(0, Math.min(1, 1 - distance / 100));
        ctx.fillStyle = distance <= HAND_DISTANCE_CM ? "#f59e0b" : "#3a3f52";
        ctx.beginPath();
        ctx.roundRect(rowX + 184, rowY + 8, Math.max(2, barMax * closeness), 8, 4);
        ctx.fill();
      }

      ctx.textAlign = "right";
      ctx.fillStyle = "#63736f";
      ctx.font = "11px monospace";
      const label = taken ? SLOTS.find((s) => state.slots[s.key] === node.id).label : "";
      ctx.fillText(label, rowX + rowW - 12, rowY + 16);
    });

    ctx.textAlign = "start";
  };

  // Counts slots filled by an online node - what the auto-advance gates on.
  window.countConfiguredNodes = function countConfiguredNodes(nodes = []) {
    return nodes.filter((node) => Boolean(node && node.online)).length;
  };
})();
