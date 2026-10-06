// gameStats.js - live round statistics, and the small in-game panels that
// draw them.
//
// game.js reports what happens during a round through window.GameStats and
// draws the panels through window.GameStatsView. Nothing here reads the game's
// own state, so every number is exactly what was reported. Everything resets
// at the start of each round.
//
//   GameStats.reset(inputMode)                  - "mouse" | "sensor" | "remote"
//   GameStats.onSpawn(type)                     - "mole" | "super" | "bomb"
//   GameStats.onFirstHit(type, reactionMs)      - first whack on a mole or hat mole
//   GameStats.onDefeat(type, hole)              - a mole or hat mole finished off
//   GameStats.onBombHit()
//   GameStats.onExpire(type)                    - a mole or hat mole missed, or a bomb dodged
//   GameStats.onTick(elapsedMs, frame)          - every frame while the round is playing
//   GameStats.onSensorReading(now, reading)     - every new sensor reading, sensor mode
//   GameStats.snapshot(now)                     - everything the panels draw
//
//   GameStatsView.renderStats(ctx, rect, snap)       - the LIVE STATS list
//   GameStatsView.renderCharts(ctx, rect, snap, now) - box plot + cycling bar chart
//   GameStatsView.CHARTS_MIN_H / statsHeight(rows)   - sizes for layout
//
// The charts sit in a game HUD, so there is no hover layer: the mouse (or the
// player's body) is the game cursor. Values are direct-labelled instead, and
// the LIVE STATS list carries the numbers.

(function () {
  const WINDOW_MS = 5000;          // the box plot's rolling window of sensor readings
  const PAGE_MS = 5000;            // how long each bar chart stays up before the next
  const SENSOR_DOMAIN_CM = 250;    // box plot axis; wide enough to show a wall reading

  // Chart colours: the dark steps of the reference categorical palette, checked
  // for colour-blind separation against the HUD panel (#16171f). Slot 1 is the
  // LEFT sensor or a mole, slot 2 the RIGHT sensor or a hat mole.
  const INK = {
    panel: "rgba(22, 23, 31, 0.86)",
    border: "rgba(255, 255, 255, 0.10)",
    primary: "#f4f4f5",
    secondary: "#c3c2b7",
    muted: "#898781",
    grid: "#2c2c2a",
    baseline: "#383835",
    series1: "#3987e5",
    series2: "#d95926",
    band: "rgba(255, 255, 255, 0.05)",
  };

  // --- Round statistics --------------------------------------------------------

  // inputMode is shown as given; only "sensor" changes what the panels draw
  // (mouse and remote both place the cursor on a hole directly).
  function emptyState(inputMode) {
    return {
      inputMode: inputMode || "mouse",
      playMs: 0,
      blockedMs: 0,
      heldMs: 0,
      onBoardMs: 0,
      spawned: { mole: 0, super: 0, bomb: 0 },
      defeated: { mole: 0, super: 0 },
      missed: { mole: 0, super: 0 },
      bombsHit: 0,
      bombsDodged: 0,
      hitsPerHole: new Array(9).fill(0),
      reactions: { mole: [], super: [] },
      lastReactionMs: null,
      streak: 0,
      bestStreak: 0,
      score: 0,
      peakLevel: 1,
      lives: null,
      livesLost: 0,
      lastCell: null,
      cellChanges: 0,
      lastPosition: null,
      travelCm: 0,
      lastSensorStatus: "ok",
      tooCloseEvents: 0,
      lostEvents: 0,
      fixSources: { both: 0, left: 0, right: 0 },
      readings: [],              // { t, raw: [left, right] } inside WINDOW_MS
      rejects: [0, 0],
      rate: [null, null],
    };
  }

  let state = emptyState("mouse");

  function isTarget(type) {
    return type === "mole" || type === "super";
  }

  const GameStats = {
    reset(inputMode) {
      state = emptyState(inputMode);
    },

    onSpawn(type) {
      if (type in state.spawned) state.spawned[type] += 1;
    },

    onFirstHit(type, reactionMs) {
      if (!isTarget(type) || !Number.isFinite(reactionMs)) return;
      state.reactions[type].push(reactionMs);
      state.lastReactionMs = reactionMs;
    },

    onDefeat(type, hole) {
      if (!isTarget(type)) return;
      state.defeated[type] += 1;
      if (hole >= 0 && hole < 9) state.hitsPerHole[hole] += 1;
      state.streak += 1;
      state.bestStreak = Math.max(state.bestStreak, state.streak);
    },

    onBombHit() {
      state.bombsHit += 1;
      state.streak = 0;
    },

    onExpire(type) {
      if (type === "bomb") {
        state.bombsDodged += 1;
      } else if (isTarget(type)) {
        state.missed[type] += 1;
        state.streak = 0;
      }
    },

    // frame: { blocked, held, sensorStatus, cell, onBoard, positionCm, score, level, lives }
    onTick(elapsedMs, frame) {
      if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
      state.playMs += elapsedMs;
      if (frame.blocked) state.blockedMs += elapsedMs;
      if (frame.held) state.heldMs += elapsedMs;
      if (frame.onBoard) state.onBoardMs += elapsedMs;

      if (Number.isInteger(frame.cell)) {
        if (state.lastCell !== null && frame.cell !== state.lastCell) state.cellChanges += 1;
        state.lastCell = frame.cell;
      }

      // Travel only joins consecutive known positions, never across a gap.
      const p = frame.positionCm;
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        if (state.lastPosition) {
          state.travelCm += Math.hypot(p.x - state.lastPosition.x, p.y - state.lastPosition.y);
        }
        state.lastPosition = { x: p.x, y: p.y };
      } else {
        state.lastPosition = null;
      }

      const status = frame.sensorStatus || "ok";
      if (status !== state.lastSensorStatus) {
        if (status === "too-close") state.tooCloseEvents += 1;
        if (status === "out-of-bounds" || status === "no-signal" || status === "offline") state.lostEvents += 1;
        state.lastSensorStatus = status;
      }

      state.score = frame.score;
      state.peakLevel = Math.max(state.peakLevel, frame.level || 1);
      if (Number.isFinite(frame.lives)) {
        if (state.lives !== null && frame.lives < state.lives) state.livesLost += state.lives - frame.lives;
        state.lives = frame.lives;
      }
    },

    // reading: { raw: [left, right], source: "both" | "left" | "right" | null,
    //            rejects: [left, right], rate: [left, right] }
    onSensorReading(now, reading) {
      state.readings.push({ t: now, raw: reading.raw });
      while (state.readings.length && now - state.readings[0].t > WINDOW_MS) state.readings.shift();
      if (reading.source && reading.source in state.fixSources) state.fixSources[reading.source] += 1;
      if (reading.rejects) state.rejects = reading.rejects.slice();
      if (reading.rate) state.rate = reading.rate.slice();
    },

    snapshot(now) {
      const s = state;
      const good = s.defeated.mole + s.defeated.super;
      const attempts = good + s.missed.mole + s.missed.super + s.bombsHit;
      const minutes = s.playMs / 60000;
      const allReactions = s.reactions.mole.concat(s.reactions.super);
      const sorted = allReactions.slice().sort((a, b) => a - b);
      const fixes = s.fixSources.both + s.fixSources.left + s.fixSources.right;

      const recent = s.readings.filter((r) => now - r.t <= WINDOW_MS);
      const sensorValues = [0, 1].map((i) => recent.map((r) => r.raw[i]).filter((v) => Number.isFinite(v)));
      const noEcho = [0, 1].map((i) =>
        recent.length ? recent.filter((r) => !Number.isFinite(r.raw[i])).length / recent.length : null);

      return {
        inputMode: s.inputMode,
        playMs: s.playMs,
        blockedMs: s.blockedMs,
        heldShare: s.playMs > 0 ? s.heldMs / s.playMs : null,
        onBoardShare: s.playMs > 0 ? s.onBoardMs / s.playMs : null,
        spawned: { ...s.spawned },
        defeated: { ...s.defeated },
        missed: s.missed.mole + s.missed.super,
        bombsHit: s.bombsHit,
        bombsDodged: s.bombsDodged,
        good,
        attempts,
        accuracy: attempts > 0 ? good / attempts : null,
        streak: s.streak,
        bestStreak: s.bestStreak,
        reaction: {
          last: s.lastReactionMs,
          mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
          median: sorted.length ? quantile(sorted, 0.5) : null,
          fastest: sorted.length ? sorted[0] : null,
        },
        hitsPerMin: minutes > 0 ? good / minutes : null,
        pointsPerMin: minutes > 0 ? s.score / minutes : null,
        peakLevel: s.peakLevel,
        livesLost: s.livesLost,
        cellChanges: s.cellChanges,
        travelCm: s.travelCm,
        tooCloseEvents: s.tooCloseEvents,
        lostEvents: s.lostEvents,
        fixShare: fixes > 0
          ? { both: s.fixSources.both / fixes, left: s.fixSources.left / fixes, right: s.fixSources.right / fixes }
          : null,
        hitsPerHole: s.hitsPerHole.slice(),
        sensorValues,
        reactionValues: [s.reactions.mole.slice(), s.reactions.super.slice()],
        health: { rate: s.rate.slice(), noEcho, rejects: s.rejects.slice() },
      };
    },
  };

  // --- Number helpers -----------------------------------------------------------

  // Linear interpolation between order statistics; sorted must be ascending.
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  // Tukey box: quartiles, whiskers at the most extreme values within 1.5 IQR,
  // and everything beyond them as outliers.
  function boxStats(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    const lowFence = q1 - 1.5 * iqr;
    const highFence = q3 + 1.5 * iqr;
    const inside = sorted.filter((v) => v >= lowFence && v <= highFence);
    return {
      n: sorted.length,
      q1,
      median: quantile(sorted, 0.5),
      q3,
      low: inside.length ? inside[0] : q1,
      high: inside.length ? inside[inside.length - 1] : q3,
      outliers: sorted.filter((v) => v < lowFence || v > highFence),
    };
  }

  // A round upper bound for an axis: 1, 2 or 5 times a power of ten.
  function niceCeil(value) {
    if (!(value > 0)) return 1;
    const power = Math.pow(10, Math.floor(Math.log10(value)));
    const step = [1, 2, 5, 10].find((m) => m * power >= value);
    return step * power;
  }

  const fmtSeconds = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)}s` : "--");
  const fmtClock = (ms) => {
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  };
  const fmtPct = (share) => (Number.isFinite(share) ? `${Math.round(share * 100)}%` : "--");
  const fmtRate = (value) => (Number.isFinite(value) ? value.toFixed(1) : "--");

  // --- Drawing helpers --------------------------------------------------------------

  function drawPanel(ctx, rect, title, subtitle) {
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.25)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = INK.panel;
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 12);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = INK.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 12);
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.font = "bold 10.5px monospace";
    ctx.fillStyle = INK.secondary;
    ctx.fillText(title, rect.x + 12, rect.y + 20);
    if (subtitle) {
      ctx.textAlign = "right";
      ctx.fillStyle = INK.muted;
      ctx.font = "10px monospace";
      ctx.fillText(subtitle, rect.x + rect.w - 12, rect.y + 20);
      ctx.textAlign = "left";
    }
  }

  function hairline(ctx, x1, y1, x2, y2, colour) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
    ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
    ctx.stroke();
  }

  // Legend chips, right-aligned at (right, y): a swatch then its label.
  function drawLegend(ctx, right, y, entries) {
    ctx.font = "10px monospace";
    ctx.textAlign = "left";
    let x = right;
    for (let i = entries.length - 1; i >= 0; i--) {
      const { label, colour } = entries[i];
      const textW = ctx.measureText(label).width;
      x -= textW;
      ctx.fillStyle = INK.secondary;
      ctx.fillText(label, x, y);
      x -= 12;
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.roundRect(x, y - 8, 8, 8, 2);
      ctx.fill();
      x -= 10;
    }
  }

  // --- Box plot -----------------------------------------------------------------------
  // Horizontal: one row per series, a shared axis along the bottom. Fewer than
  // five values are drawn as plain dots - a box of three points is a fiction.
  // band: optional { from, to } shaded behind the plot (the calibrated play depth).

  function renderBoxPlot(ctx, rect, spec) {
    const labelW = 40;
    const axisH = 14;
    const plot = { x: rect.x + labelW, y: rect.y, w: rect.w - labelW - 6, h: rect.h - axisH };
    const rowH = plot.h / spec.series.length;
    const toX = (v) => plot.x + (Math.max(0, Math.min(spec.max, v)) / spec.max) * plot.w;

    if (spec.band) {
      ctx.fillStyle = INK.band;
      ctx.fillRect(toX(spec.band.from), plot.y, toX(spec.band.to) - toX(spec.band.from), plot.h);
    }

    // Axis: hairline gridlines at each tick, labels below.
    ctx.font = "9px monospace";
    ctx.textAlign = "center";
    spec.ticks.forEach((tick) => {
      const x = toX(tick);
      hairline(ctx, x, plot.y, x, plot.y + plot.h, INK.grid);
      ctx.fillStyle = INK.muted;
      ctx.fillText(`${tick}`, x, plot.y + plot.h + 11);
    });
    ctx.textAlign = "right";
    ctx.fillText(spec.unit, rect.x + labelW - 6, plot.y + plot.h + 11);

    spec.series.forEach((series, i) => {
      const cy = plot.y + rowH * i + rowH / 2;
      ctx.textAlign = "left";
      ctx.font = "bold 10px monospace";
      ctx.fillStyle = INK.secondary;
      ctx.fillText(series.label, rect.x, cy + 4);

      const values = series.values;
      if (!values.length) {
        ctx.font = "10px monospace";
        ctx.fillStyle = INK.muted;
        ctx.fillText("no data", plot.x + 4, cy + 4);
        return;
      }

      if (values.length < 5) {
        values.forEach((v) => dot(ctx, toX(v), cy, series.colour));
        return;
      }

      const b = boxStats(values);
      const boxH = Math.min(14, rowH - 6);

      // Whisker, then the box, then the median on top.
      ctx.strokeStyle = series.colour;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(toX(b.low), cy);
      ctx.lineTo(toX(b.q1), cy);
      ctx.moveTo(toX(b.q3), cy);
      ctx.lineTo(toX(b.high), cy);
      ctx.moveTo(toX(b.low), cy - boxH / 3);
      ctx.lineTo(toX(b.low), cy + boxH / 3);
      ctx.moveTo(toX(b.high), cy - boxH / 3);
      ctx.lineTo(toX(b.high), cy + boxH / 3);
      ctx.stroke();

      const bx = toX(b.q1);
      const bw = Math.max(2, toX(b.q3) - bx);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = series.colour;
      ctx.beginPath();
      ctx.roundRect(bx, cy - boxH / 2, bw, boxH, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(bx, cy - boxH / 2, bw, boxH, 3);
      ctx.stroke();

      ctx.strokeStyle = INK.primary;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(toX(b.median), cy - boxH / 2);
      ctx.lineTo(toX(b.median), cy + boxH / 2);
      ctx.stroke();

      b.outliers.forEach((v) => dot(ctx, toX(v), cy, series.colour, 3));

      // Direct label: the median, right of the whisker when there is room.
      const label = spec.format(b.median);
      ctx.font = "9px monospace";
      const tx = toX(b.high) + 6;
      if (tx + ctx.measureText(label).width < plot.x + plot.w) {
        ctx.fillStyle = INK.secondary;
        ctx.fillText(label, tx, cy + 3);
      }
    });
    ctx.textAlign = "left";
  }

  // A dot with a 2px ring in the panel colour, so overlapping dots stay legible.
  function dot(ctx, x, y, colour, radius = 4) {
    ctx.fillStyle = "#16171f";
    ctx.beginPath();
    ctx.arc(x, y, radius + 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- Bar charts ---------------------------------------------------------------------
  // Vertical bars from one baseline: <= 24px thick, 4px rounded tops, square at
  // the baseline, the value above each bar and the category below it.

  function renderBars(ctx, rect, bars, options = {}) {
    const labelH = 13;
    const valueH = 12;
    const plot = { x: rect.x, y: rect.y + valueH, w: rect.w, h: rect.h - labelH - valueH };
    const max = options.max || Math.max(1, ...bars.map((b) => (Number.isFinite(b.value) ? b.value : 0)));
    const slot = plot.w / bars.length;
    const barW = Math.min(24, slot - 4);
    const baseY = plot.y + plot.h;

    hairline(ctx, plot.x, baseY, plot.x + plot.w, baseY, INK.baseline);

    bars.forEach((bar, i) => {
      const cx = plot.x + slot * i + slot / 2;
      const value = Number.isFinite(bar.value) ? bar.value : 0;
      const h = (Math.min(value, max) / max) * plot.h;
      if (h > 0) {
        ctx.fillStyle = bar.colour || INK.series1;
        ctx.beginPath();
        ctx.roundRect(cx - barW / 2, baseY - h, barW, h, [Math.min(4, h), Math.min(4, h), 0, 0]);
        ctx.fill();
      }

      ctx.textAlign = "center";
      ctx.font = "9px monospace";
      ctx.fillStyle = INK.secondary;
      const shown = bar.display !== undefined ? bar.display : Number.isFinite(bar.value) ? `${bar.value}` : "--";
      ctx.fillText(shown, cx, baseY - h - 3);
      ctx.fillStyle = INK.muted;
      ctx.fillText(bar.label, cx, baseY + 11);
    });
    ctx.textAlign = "left";
  }

  // Sensor health: three measures in different units, so three small charts
  // side by side, each on its own scale - never one axis for all three.
  function renderHealth(ctx, rect, health) {
    const groups = [
      {
        title: "rate /s",
        values: health.rate,
        max: niceCeil(Math.max(25, ...health.rate.filter(Number.isFinite))),
        display: (v) => fmtRate(v),
      },
      {
        title: "no echo",
        values: health.noEcho.map((v) => (Number.isFinite(v) ? v * 100 : null)),
        max: 100,
        display: (v) => (Number.isFinite(v) ? `${Math.round(v)}%` : "--"),
      },
      {
        title: "rejected",
        values: health.rejects,
        max: niceCeil(Math.max(5, ...health.rejects.filter(Number.isFinite))),
        display: (v) => (Number.isFinite(v) ? `${v}` : "--"),
      },
    ];
    const gap = 10;
    const groupW = (rect.w - gap * (groups.length - 1)) / groups.length;
    groups.forEach((group, i) => {
      const gx = rect.x + i * (groupW + gap);
      ctx.fillStyle = INK.muted;
      ctx.font = "9px monospace";
      ctx.textAlign = "center";
      ctx.fillText(group.title, gx + groupW / 2, rect.y + rect.h);
      renderBars(ctx, { x: gx, y: rect.y, w: groupW, h: rect.h - 10 }, [
        { label: "L", value: group.values[0], colour: INK.series1, display: group.display(group.values[0]) },
        { label: "R", value: group.values[1], colour: INK.series2, display: group.display(group.values[1]) },
      ], { max: group.max });
    });
  }

  function barPages(snap) {
    const pages = [
      {
        title: "Hits per hole",
        render: (ctx, rect) => renderBars(ctx, rect,
          snap.hitsPerHole.map((value, i) => ({ label: `${i + 1}`, value }))),
      },
      {
        title: "Outcomes",
        render: (ctx, rect) => renderBars(ctx, rect, [
          { label: "mole", value: snap.defeated.mole },
          { label: "hat", value: snap.defeated.super },
          { label: "miss", value: snap.missed },
          { label: "bomb", value: snap.bombsHit },
          { label: "dodge", value: snap.bombsDodged },
        ]),
      },
    ];
    if (snap.inputMode === "sensor") {
      pages.push({
        title: "Sensor health",
        legend: [{ label: "L", colour: INK.series1 }, { label: "R", colour: INK.series2 }],
        render: (ctx, rect) => renderHealth(ctx, rect, snap.health),
      });
    }
    return pages;
  }

  function boxSpec(snap, band) {
    if (snap.inputMode === "sensor") {
      return {
        title: "Raw distance, last 5 s",
        unit: "cm",
        max: SENSOR_DOMAIN_CM,
        ticks: [0, 50, 100, 150, 200, 250],
        band,
        format: (v) => `${Math.round(v)}`,
        series: [
          { label: "L", colour: INK.series1, values: snap.sensorValues[0] },
          { label: "R", colour: INK.series2, values: snap.sensorValues[1] },
        ],
        legend: [{ label: "L", colour: INK.series1 }, { label: "R", colour: INK.series2 }],
      };
    }
    const seconds = snap.reactionValues.map((list) => list.map((ms) => ms / 1000));
    const max = niceCeil(Math.max(1, ...seconds[0], ...seconds[1]));
    const step = max / 4;
    return {
      title: "Reaction time",
      unit: "s",
      max,
      ticks: [0, step, step * 2, step * 3, max].map((t) => Number(t.toFixed(2))),
      format: (v) => `${v.toFixed(2)}`,
      series: [
        { label: "mole", colour: INK.series1, values: seconds[0] },
        { label: "hat", colour: INK.series2, values: seconds[1] },
      ],
      legend: [{ label: "mole", colour: INK.series1 }, { label: "hat", colour: INK.series2 }],
    };
  }

  // --- Panels -------------------------------------------------------------------------

  const CHARTS_MIN_H = 200;
  const STATS_ROW_H = 16;
  const STATS_HEADER_H = 30;

  // rect: { x, y, w, h }. band: the calibrated play depth { from, to } in cm, if any.
  function renderCharts(ctx, rect, snap, now, band) {
    drawPanel(ctx, rect, "LIVE DATA", snap.inputMode);

    const inner = { x: rect.x + 12, w: rect.w - 24 };
    const available = rect.h - 30 - 12;
    const boxH = Math.max(64, Math.round(available * 0.42));
    let y = rect.y + 30;

    const spec = boxSpec(snap, band);
    ctx.font = "bold 10px monospace";
    ctx.fillStyle = INK.primary;
    ctx.textAlign = "left";
    ctx.fillText(spec.title, inner.x, y + 10);
    drawLegend(ctx, inner.x + inner.w, y + 10, spec.legend);
    renderBoxPlot(ctx, { x: inner.x, y: y + 16, w: inner.w, h: boxH - 16 }, spec);
    y += boxH + 10;
    hairline(ctx, inner.x, y - 5, inner.x + inner.w, y - 5, INK.grid);

    const pages = barPages(snap);
    const pageIndex = Math.floor(now / PAGE_MS) % pages.length;
    const page = pages[pageIndex];
    ctx.font = "bold 10px monospace";
    ctx.fillStyle = INK.primary;
    ctx.textAlign = "left";
    ctx.fillText(page.title, inner.x, y + 10);

    // Page dots, so it is clear the chart cycles and where it is up to.
    pages.forEach((_, i) => {
      ctx.fillStyle = i === pageIndex ? INK.primary : INK.baseline;
      ctx.beginPath();
      ctx.arc(inner.x + inner.w - (pages.length - 1 - i) * 10 - 3, y + 7, 3, 0, Math.PI * 2);
      ctx.fill();
    });
    if (page.legend) drawLegend(ctx, inner.x + inner.w - pages.length * 10 - 6, y + 10, page.legend);

    const barsRect = { x: inner.x, y: y + 16, w: inner.w, h: rect.y + rect.h - 12 - (y + 16) };
    if (barsRect.h >= 40) page.render(ctx, barsRect);
    ctx.textAlign = "left";
  }

  // The LIVE STATS rows, most important first; a panel short on room shows the
  // top of the list.
  function statsRows(snap) {
    const rows = [
      ["Time", fmtClock(snap.playMs)],
      ["Accuracy", snap.accuracy === null ? "--" : `${fmtPct(snap.accuracy)} (${snap.good}/${snap.attempts})`],
      ["Streak / best", `${snap.streak} / ${snap.bestStreak}`],
      ["Reaction avg", fmtSeconds(snap.reaction.mean)],
      ["Fastest", fmtSeconds(snap.reaction.fastest)],
      ["Hits / min", fmtRate(snap.hitsPerMin)],
    ];
    if (snap.inputMode === "sensor") {
      const f = snap.fixShare;
      rows.push(
        ["Fix L+R / L / R", f ? `${fmtPct(f.both)} ${fmtPct(f.left)} ${fmtPct(f.right)}` : "--"],
        ["Sensor pause", fmtClock(snap.blockedMs)],
        ["Held", fmtPct(snap.heldShare)],
        ["Too-close alerts", `${snap.tooCloseEvents}`],
        ["Lost signal", `${snap.lostEvents}`],
      );
    }
    rows.push(
      ["Points / min", fmtRate(snap.pointsPerMin)],
      ["Moles hit", `${snap.defeated.mole} / ${snap.spawned.mole}`],
      ["Hat moles hit", `${snap.defeated.super} / ${snap.spawned.super}`],
      ["Missed", `${snap.missed}`],
      ["Bombs hit", `${snap.bombsHit} / ${snap.spawned.bomb}`],
      ["Bombs dodged", `${snap.bombsDodged}`],
      ["Reaction median", fmtSeconds(snap.reaction.median)],
      ["Last reaction", fmtSeconds(snap.reaction.last)],
      ["Lives lost", `${snap.livesLost}`],
      ["Peak level", `${snap.peakLevel}`],
      ["Cell changes", `${snap.cellChanges}`],
      ["Cursor travel", `${(snap.travelCm / 100).toFixed(1)} m`],
      ["On board", fmtPct(snap.onBoardShare)],
    );
    return rows;
  }

  function statsHeight(rowCount) {
    return STATS_HEADER_H + rowCount * STATS_ROW_H + 8;
  }

  function renderStats(ctx, rect, snap) {
    const rows = statsRows(snap);
    const fit = Math.max(0, Math.floor((rect.h - STATS_HEADER_H - 8) / STATS_ROW_H));
    const shown = rows.slice(0, fit);
    const panel = { ...rect, h: statsHeight(shown.length) };
    drawPanel(ctx, panel, "LIVE STATS", shown.length < rows.length ? `top ${shown.length} of ${rows.length}` : null);

    shown.forEach(([label, value], i) => {
      const y = panel.y + STATS_HEADER_H + STATS_ROW_H * i + 8;
      ctx.font = "11px monospace";
      ctx.textAlign = "left";
      ctx.fillStyle = INK.muted;
      ctx.fillText(label, panel.x + 12, y);
      ctx.textAlign = "right";
      ctx.fillStyle = INK.primary;
      ctx.fillText(value, panel.x + panel.w - 12, y);
    });
    ctx.textAlign = "left";
  }

  function statsRowCount(snap) {
    return statsRows(snap).length;
  }

  window.GameStats = GameStats;
  window.GameStatsView = {
    renderStats,
    renderCharts,
    statsHeight,
    statsRowCount,
    CHARTS_MIN_H,
  };
})();
