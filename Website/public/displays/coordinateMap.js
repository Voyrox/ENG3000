// coordinateMap.js - a small top-down map of where the player is.
//
// Deliberately knows nothing about sensors. It takes a position in
// centimetres and draws it, so it keeps working unchanged when the
// three-sensor rig is replaced by the servo scanner, or when the filtered
// coordinate starts arriving from filterRules.py on the server.
//
//   const map = new CoordinateMap({ widthCm: 150, depthCm: 150 });
//   map.setColumns([{ near, far }, ...]);  // optional: real row boundaries
//   map.update(x, y);                      // centimetres; null, null clears it
//   map.update(x, y, "held");              // optional short state label
//   map.update(x, y, null, { gx, gy });    // optional: the cell the host used
//   map.render(ctx, left, top);
//
// The map never works out a cell for itself. A cell is a DECISION - row
// hysteresis and a majority vote go into it - and a map that re-derived one
// from x and y would sometimes disagree with the game while claiming to show
// it. So a cell is only highlighted when the host passes the one it used.
//
// Coordinates follow the project convention: x runs left to right, y is depth
// from the screen, and (0, 0) is bottom-left - so the edge nearest the screen
// is drawn at the BOTTOM of the map, matching the game board.

(function () {
  const PALETTE = {
    background: "#000000",
    border: "rgba(255, 255, 255, 0.14)",
    grid: "#262b36",
    cellFill: "rgba(250, 204, 21, 0.10)",
    offBoard: "rgba(255, 255, 255, 0.035)",
    edge: "#3a4150",
    cursor: "#facc15",
    outside: "#ef4444",
    title: "#9298aa",
    text: "#e6e9ef",
    muted: "#6b7385",
  };

  const PAD = 12;
  const HEADER_H = 20;
  const FOOTER_H = 34;
  const CURSOR_RADIUS = 7;

  // Non-ASCII glyphs as escapes, so they survive a host page that forgets to
  // declare its encoding. Literal characters render as mojibake there.
  const GLYPH_DOWN = "\u25BC";
  const GLYPH_DASH = "\u2014";

  class CoordinateMap {
    constructor(options = {}) {
      this.widthCm = options.widthCm ?? 150;
      this.depthCm = options.depthCm ?? 150;
      this.divisions = options.divisions ?? 3;
      this.size = options.size ?? 170;
      this.trailLength = options.trail ?? 14;
      this.title = options.title ?? "POSITION";
      this.columns = null;
      this.clear();
    }

    // Per-column { near, far } in cm, one entry per column. Rows are drawn
    // between each column's own edges, so the grid matches the calibrated play
    // area rather than an even split of the whole depth. null restores that
    // even split, for a source that has no calibration.
    setColumns(columns) {
      const valid = Array.isArray(columns) && columns.length === this.divisions
        && columns.every((c) => Number.isFinite(c.near) && Number.isFinite(c.far) && c.far > c.near);
      this.columns = valid ? columns.map((c) => ({ near: c.near, far: c.far })) : null;
    }

    // Total footprint, so a caller can position the map without guessing.
    get width() {
      return this.size + PAD * 2;
    }

    get height() {
      return PAD + HEADER_H + this.size + FOOTER_H;
    }

    clear() {
      this.point = null;
      this.label = null;
      this.cell = null;
      this.trail = [];
    }

    // x, y in centimetres. Pass null for either to show "no position".
    //
    // Safe to call every render frame: the trail only grows when the point
    // actually moves, so it records distinct positions whatever the call rate
    // - 60 fps from the render loop, or however often the server sends one.
    update(x, y, label = null, cell = null) {
      this.label = label;
      this.cell = cell && Number.isInteger(cell.gx) && Number.isInteger(cell.gy) ? cell : null;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        this.point = null;
        return;
      }
      this.point = { x, y };
      const last = this.trail[this.trail.length - 1];
      if (!last || last.x !== x || last.y !== y) {
        this.trail.push({ x, y });
        while (this.trail.length > this.trailLength) this.trail.shift();
      }
    }

    // Is the point inside the mapped area? Out-of-range positions are still
    // drawn, pinned to the edge, so the player can see which way they went.
    isInside(point) {
      return point.x >= 0 && point.x <= this.widthCm && point.y >= 0 && point.y <= this.depthCm;
    }

    // The { near, far } span that rows are drawn within, for one column.
    spanFor(column) {
      return this.columns ? this.columns[column] : { near: 0, far: this.depthCm };
    }

    render(ctx, left, top) {
      const plotX = left + PAD;
      const plotY = top + PAD + HEADER_H;
      const size = this.size;

      ctx.save();
      this.drawPanel(ctx, left, top);
      this.drawHeader(ctx, left, top);
      this.drawGrid(ctx, plotX, plotY, size);
      this.drawCell(ctx, plotX, plotY, size);
      if (this.point) {
        this.drawTrail(ctx, plotX, plotY, size);
        this.drawCursor(ctx, plotX, plotY, size);
      } else {
        this.drawEmpty(ctx, plotX, plotY, size);
      }
      this.drawFooter(ctx, left, plotY + size);
      ctx.restore();
    }

    // --- drawing -------------------------------------------------------------

    toScreen(point, plotX, plotY, size) {
      // Out-of-range points are pinned a cursor-radius inside the plot, so the
      // ring stays fully visible instead of spilling into the header.
      const inset = (CURSOR_RADIUS + 2) / size;
      const clamp = (v) => Math.max(inset, Math.min(1 - inset, v));
      const pin = (v) => (this.isInside(point) ? v : clamp(v));
      return {
        sx: plotX + pin(point.x / this.widthCm) * size,
        // Canvas y grows downward; map depth grows upward from the screen edge.
        sy: plotY + size - pin(point.y / this.depthCm) * size,
      };
    }

    drawPanel(ctx, left, top) {
      ctx.fillStyle = PALETTE.background;
      ctx.strokeStyle = PALETTE.border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(left, top, this.width, this.height, 10);
      ctx.fill();
      ctx.stroke();
    }

    drawHeader(ctx, left, top) {
      ctx.textBaseline = "alphabetic";
      ctx.font = "bold 10.5px monospace";
      ctx.fillStyle = PALETTE.title;
      ctx.textAlign = "left";
      ctx.fillText(this.title, left + PAD, top + PAD + 11);

      if (this.label) {
        ctx.textAlign = "right";
        ctx.fillStyle = this.label === "held" ? PALETTE.cursor : PALETTE.outside;
        ctx.fillText(this.label.toUpperCase(), left + this.width - PAD, top + PAD + 11);
      }
    }

    // Canvas y for a depth in cm. Depth grows up the map, canvas y grows down.
    depthToY(cm, plotY, size) {
      const t = Math.max(0, Math.min(1, cm / this.depthCm));
      return plotY + size - t * size;
    }

    drawGrid(ctx, plotX, plotY, size) {
      const columnW = size / this.divisions;
      const line = (x1, y1, x2, y2, colour) => {
        ctx.strokeStyle = colour;
        ctx.beginPath();
        ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
        ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
        ctx.stroke();
      };
      ctx.lineWidth = 1;

      for (let c = 0; c < this.divisions; c++) {
        const x0 = plotX + c * columnW;
        const x1 = x0 + columnW;
        const { near, far } = this.spanFor(c);
        const yNear = this.depthToY(near, plotY, size);
        const yFar = this.depthToY(far, plotY, size);

        // Shade the parts of this column that are off the board.
        ctx.fillStyle = PALETTE.offBoard;
        ctx.fillRect(x0, yNear, columnW, plotY + size - yNear);
        ctx.fillRect(x0, plotY, columnW, yFar - plotY);

        // This column's own play edges, then its own row boundaries.
        line(x0, yNear, x1, yNear, PALETTE.edge);
        line(x0, yFar, x1, yFar, PALETTE.edge);
        for (let r = 1; r < this.divisions; r++) {
          const y = this.depthToY(near + ((far - near) * r) / this.divisions, plotY, size);
          line(x0, y, x1, y, PALETTE.grid);
        }
      }
      for (let c = 0; c <= this.divisions; c++) {
        line(plotX + c * columnW, plotY, plotX + c * columnW, plotY + size, PALETTE.grid);
      }
    }

    drawCell(ctx, plotX, plotY, size) {
      if (!this.cell) return;
      const { gx, gy } = this.cell;
      if (gx < 0 || gx >= this.divisions || gy < 0 || gy >= this.divisions) return;
      const columnW = size / this.divisions;
      const { near, far } = this.spanFor(gx);
      const rowDepth = (far - near) / this.divisions;
      const yTop = this.depthToY(near + (gy + 1) * rowDepth, plotY, size);
      const yBottom = this.depthToY(near + gy * rowDepth, plotY, size);
      ctx.fillStyle = PALETTE.cellFill;
      ctx.fillRect(plotX + gx * columnW, yTop, columnW, yBottom - yTop);
    }

    drawTrail(ctx, plotX, plotY, size) {
      const count = this.trail.length;
      this.trail.forEach((point, i) => {
        if (i === count - 1) return;               // the cursor covers the latest
        const { sx, sy } = this.toScreen(point, plotX, plotY, size);
        ctx.globalAlpha = 0.08 + 0.4 * (i / count);
        ctx.fillStyle = PALETTE.cursor;
        ctx.beginPath();
        ctx.arc(sx, sy, 2.2, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
    }

    drawCursor(ctx, plotX, plotY, size) {
      const inside = this.isInside(this.point);
      const colour = inside ? PALETTE.cursor : PALETTE.outside;
      const { sx, sy } = this.toScreen(this.point, plotX, plotY, size);

      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(sx, plotY);
      ctx.lineTo(sx, plotY + size);
      ctx.moveTo(plotX, sy);
      ctx.lineTo(plotX + size, sy);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.shadowColor = colour;
      ctx.shadowBlur = 10;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, CURSOR_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Solid when inside, hollow when pinned to the edge from outside.
      if (inside) {
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    drawEmpty(ctx, plotX, plotY, size) {
      ctx.fillStyle = PALETTE.muted;
      ctx.font = "bold 11px monospace";
      ctx.textAlign = "center";
      ctx.fillText("NO POSITION", plotX + size / 2, plotY + size / 2 + 4);
    }

    drawFooter(ctx, left, plotBottom) {
      ctx.font = "9px monospace";
      ctx.fillStyle = PALETTE.muted;
      ctx.textAlign = "center";
      ctx.fillText(`${GLYPH_DOWN} screen`, left + this.width / 2, plotBottom + 12);

      ctx.font = "bold 11px monospace";
      ctx.textAlign = "left";
      if (!this.point) {
        ctx.fillStyle = PALETTE.muted;
        ctx.fillText(`x   ${GLYPH_DASH}    y   ${GLYPH_DASH}`, left + PAD, plotBottom + 28);
        return;
      }
      ctx.fillStyle = this.isInside(this.point) ? PALETTE.text : PALETTE.outside;
      const fmt = (v) => v.toFixed(1).padStart(6);
      ctx.fillText(`x${fmt(this.point.x)}  y${fmt(this.point.y)} cm`, left + PAD, plotBottom + 28);
    }
  }

  window.CoordinateMap = CoordinateMap;
})();
