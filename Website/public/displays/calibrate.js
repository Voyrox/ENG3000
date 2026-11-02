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
// One node (Aaron, 2 Nov; the control panel's One node switch, on by
// default): a round can also be played with one working node. Skip this
// sensor leaves the active slot empty, and Start Game unlocks once one node is
// identified and either the other slot is skipped or no other node is
// connected to identify (Start Game then leaves that slot empty itself). The
// game places the player from that node alone and goes Out of bounds when it
// is lost (game.js slotsInUse()). With the switch off both nodes are needed,
// as before.
//
// API on `window`:
//   window.updateSensorAssignment(nodes, now) - run detection, call on each update
//   window.getSensorAssignment()              - [leftId, null, rightId]
//   window.isSensorAssignmentComplete()       - both identified, or one and the other skipped
//   window.canStartOneNode()                  - one identified and no other node to identify
//   window.finishSensorAssignment()           - skips what is left if canStartOneNode(); complete?
//   window.skipSensorSlot()                   - leave the active slot empty (One node on)
//   window.resetSensorAssignment()
//   window.updateCalibrateScreen(nodes)      - fill in the "calibrate" section of index.html

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
    // Left empty with Skip this sensor: a one-node round (One node on).
    skipped: { left: false, right: false },
    // Connected nodes not assigned to a slot, as of the last update.
    spare: 0,
    candidateId: null,
    dwellStartedAt: 0,
    dwellProgress: 0, // 0..1, drives the progress bar
  };

  // The One node switch (game.js), on by default.
  function oneNodeOn() {
    return window.getOneNode ? window.getOneNode() : true;
  }

  // A skipped slot only counts while the switch is on: turned off, the slot
  // asks for its node again.
  function isSkipped(key) {
    return oneNodeOn() && state.skipped[key];
  }

  // The first slot still waiting for a hand, LEFT then RIGHT, or null.
  function activeSlot() {
    return SLOTS.find((slot) => state.slots[slot.key] === null && !isSkipped(slot.key)) || null;
  }

  function assignedIds() {
    return SLOTS.map((slot) => state.slots[slot.key]);
  }

  function assignedCount() {
    return assignedIds().filter((id) => id !== null).length;
  }

  // Both nodes identified, or (One node on) one, with the other slot skipped.
  function isComplete() {
    if (assignedCount() === SLOTS.length) return true;
    return assignedCount() > 0 && SLOTS.every((slot) => state.slots[slot.key] !== null || isSkipped(slot.key));
  }

  // One node identified and no other node connected to identify: Start Game
  // can leave the other slot empty (finishSensorAssignment()).
  function canStartOneNode() {
    return oneNodeOn() && !isComplete() && assignedCount() > 0 && state.spare === 0;
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
  window.canStartOneNode = canStartOneNode;

  // Start Game's check: with one node identified and none left to identify,
  // the empty slot is skipped. Returns whether the assignment is complete.
  window.finishSensorAssignment = function finishSensorAssignment() {
    if (canStartOneNode()) {
      SLOTS.forEach((slot) => {
        if (state.slots[slot.key] === null) state.skipped[slot.key] = true;
      });
      clearDwell();
    }
    return isComplete();
  };

  // Skip this sensor: the active slot is left empty, so a node that does not
  // work can be left out. Never both: one slot always needs its node. Returns
  // whether it skipped.
  window.skipSensorSlot = function skipSensorSlot() {
    const slot = activeSlot();
    if (!oneNodeOn() || !slot) return false;
    if (SLOTS.some((other) => other.key !== slot.key && isSkipped(other.key))) return false;
    state.skipped[slot.key] = true;
    clearDwell();
    return true;
  };

  window.resetSensorAssignment = function resetSensorAssignment() {
    SLOTS.forEach((slot) => {
      state.slots[slot.key] = null;
      state.skipped[slot.key] = false;
    });
    state.spare = 0;
    clearDwell();
  };

  window.getSensorAssignmentState = function getSensorAssignmentState() {
    return {
      slots: { ...state.slots },
      skipped: { left: isSkipped("left"), right: isSkipped("right") },
      activeKey: activeSlot() ? activeSlot().key : null,
      dwellProgress: state.dwellProgress,
      candidateId: state.candidateId,
      complete: isComplete(),
      oneNodeReady: canStartOneNode(),
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

    if (dropped) clearDwell();
  }

  // Runs the detection for the active slot. Call whenever fresh node data
  // arrives; `now` defaults to the current time.
  window.updateSensorAssignment = function updateSensorAssignment(nodes = [], now) {
    const time = Number.isFinite(now) ? now : performance.now();
    pruneMissing(nodes);

    const taken = new Set(assignedIds().filter((id) => id !== null));
    state.spare = nodes.filter((node) => !taken.has(node.id)).length;

    const slot = activeSlot();
    if (!slot) {
      clearDwell();
      return;
    }

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
      state.spare -= 1;
      clearDwell();
    }
  };

  // --- Screen (the "calibrate" section in index.html) -----------------------
  //
  // Looked up on first use rather than at load, so this file still runs where
  // there is no page at all.
  let view = null;

  function bindView() {
    const root = document.getElementById("calibrate");
    view = {
      instruction: document.getElementById("calInstruction"),
      hint: document.getElementById("calHint"),
      readings: document.getElementById("calReadings"),
      hold: document.getElementById("calHold"),
      start: document.getElementById("calStart"),
      skipSensor: document.getElementById("calSkipSensor"),
      slots: Object.fromEntries(
        SLOTS.map((slot) => [slot.key, root.querySelector(`[data-slot="${slot.key}"]`)])
      ),
    };
  }

  function formatCm(distance) {
    return distance === null ? "no echo" : `${distance.toFixed(1)} cm`;
  }

  window.updateCalibrateScreen = function updateCalibrateScreen(nodes = []) {
    if (!view) bindView();
    const slot = activeSlot();
    const oneNodeReady = canStartOneNode();
    const ready = isComplete() || oneNodeReady;

    if (ready && assignedCount() === SLOTS.length) {
      view.instruction.textContent = "Both sensors identified";
      view.instruction.className = "instruction";
      view.hint.textContent = "Aim both nodes straight, then press Start Game.";
    } else if (ready) {
      const alone = SLOTS.find((entry) => state.slots[entry.key] !== null);
      view.instruction.textContent = `One sensor: the ${alone.key} node plays alone`;
      view.instruction.className = "instruction";
      view.hint.textContent = "Aim it straight, then press Start Game. Its servo follows you across the board.";
    } else if (nodes.length === 0) {
      view.instruction.textContent = "Waiting for the sensors to connect";
      view.instruction.className = "instruction is-fault";
      view.hint.textContent = "Power the nodes on. They show up under Live readings as they join.";
    } else {
      view.instruction.textContent = `Hold your hand in front of the ${slot.key} sensor`;
      view.instruction.className = "instruction is-wait";
      // With one node connected and nothing identified yet, it may be the
      // right node, which needs the left slot skipped first.
      const lone = oneNodeOn() && nodes.length === 1 && assignedCount() === 0 && slot.key === "left";
      view.hint.textContent = lone
        ? "Only one node is connected. If it is the right node, press Skip left sensor first."
        : oneNodeOn()
          ? `Keep it steady until the bar fills, or press Skip ${slot.key} sensor if it does not work.`
          : "Keep it steady until the bar fills.";
    }

    SLOTS.forEach((entry) => {
      const el = view.slots[entry.key];
      const assignedId = state.slots[entry.key];
      const isActive = !ready && slot && slot.key === entry.key;
      const skipped = assignedId === null && (isSkipped(entry.key) || oneNodeReady);
      el.classList.toggle("is-assigned", assignedId !== null);
      el.classList.toggle("is-skipped", skipped);
      el.classList.toggle("is-active", Boolean(isActive));

      const side = el.querySelector(".slot-side");
      const value = el.querySelector(".slot-value");
      const meta = el.querySelector(".slot-meta");
      const label = `${entry.key === "left" ? "Left" : "Right"} sensor`;

      if (assignedId !== null) {
        side.innerHTML = `<svg class="icon"><use href="#i-check" /></svg>${label}`;
        value.textContent = `Node ${assignedId}`;
        meta.textContent = formatCm(distanceFor(nodes.find((n) => n.id === assignedId)));
      } else if (skipped) {
        side.textContent = label;
        value.textContent = "Not used";
        meta.textContent = "one-node round";
      } else {
        side.textContent = label;
        value.textContent = isActive ? "Waiting for a hand" : "Not assigned yet";
        meta.textContent = "";
      }
      el.querySelector(".meter span").style.transform =
        `scaleX(${isActive ? state.dwellProgress : 0})`;
    });

    // Live readings, so the operator can see the rig responding. Nearer
    // readings draw a longer bar, so a hand is obvious at a glance.
    view.readings.innerHTML = nodes.length
      ? nodes
          .slice()
          .sort((a, b) => a.id - b.id)
          .map((node) => {
            const distance = distanceFor(node);
            const takenBy = SLOTS.find((s) => state.slots[s.key] === node.id);
            const closeness = distance === null ? 0 : Math.max(0, Math.min(1, 1 - distance / 100));
            const hand = distance !== null && distance <= HAND_DISTANCE_CM;
            const candidate = state.candidateId === node.id ? "is-candidate" : "";
            // The angle the node says its servo is at: it should sit on 90 for
            // the whole screen, so anything else (amber) means it is not holding.
            const angle = angleFor(node);
            const angleText = angle === null ? "-" : `${Math.round(angle)}°`;
            const angleClass = angle === null ? "" : Math.round(angle) === AIM_ANGLE_DEG ? " is-held" : " is-off";
            return `<li class="${candidate}">
                <span class="reading-id">Node ${node.id}</span>
                <span class="reading-cm">${formatCm(distance)}</span>
                <span class="reading-bar${hand ? " is-hand" : ""}"><span style="transform: scaleX(${closeness.toFixed(3)})"></span></span>
                <span class="reading-angle${angleClass}">${angleText}</span>
                <span class="reading-slot">${takenBy ? (takenBy.key === "left" ? "Left" : "Right") : ""}</span>
              </li>`;
          })
          .join("")
      : '<li class="empty">No sensor nodes connected yet.</li>';

    // The servos are held straight for as long as this screen is up, through
    // both steps (canvas.js sends the hold; the server passes AIM 90 to every node).
    view.hold.textContent = ready && assignedCount() === 1
      ? `Servo held at ${AIM_ANGLE_DEG}° throughout - aim the node straight out into the play area.`
      : `Servos held at ${AIM_ANGLE_DEG}° throughout - aim both nodes straight out into the play area.`;

    // Start Game: live once both nodes are identified (or one, with One node
    // on), and where focus lands then.
    view.start.disabled = !ready;
    view.start.toggleAttribute("data-default-focus", ready);

    // Skip this sensor: One node on, a slot waiting for a hand, and the other
    // slot not skipped already.
    const canSkip = oneNodeOn() && !ready && slot !== null &&
      !SLOTS.some((other) => other.key !== slot.key && isSkipped(other.key));
    view.skipSensor.hidden = !canSkip;
    view.skipSensor.disabled = !canSkip;
    if (slot) view.skipSensor.querySelector("span").textContent = `Skip ${slot.key} sensor`;
  };

})();
