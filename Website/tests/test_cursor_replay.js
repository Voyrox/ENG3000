// test_cursor_replay.js
//
// Website/tools/cursor_replay.js scores how steady the sensor cursor's cell
// is and how fast it follows a move. These tests check its measures on cell
// sequences worked out by hand, and that a short run of the REAL game.js on
// the ideal model rig finds a still player's cell:
//
//   1. flips: the gap between holes is no cell (A, gap, A is no flip)
//   2. strays: entries into a cell outside the right set, once per entry
//   3. latency: from the crossing to the last move onto the new cell; a step
//      whose new cell is not showing at the end is missed (null)
//   4. a still player in the middle of a cell, ideal rig: all three cells
//      right, and none of them flipping
//
// Run with:
//
//     node --test Website/tests/test_cursor_replay.js

const assert = require("assert");
const path = require("path");
const test = require("node:test");

const replay = require(path.join(__dirname, "..", "tools", "cursor_replay.js"));

const SITE = path.join(__dirname, "..", "public");

test("a flip is a change of cell; the gap between holes is not a cell", () => {
  assert.strictEqual(replay.countFlips([4, 4, null, 4, 4]), 0);
  assert.strictEqual(replay.countFlips([4, null, 5, 5, 4]), 2);
  assert.strictEqual(replay.countFlips([null, null, 4]), 0);
  assert.strictEqual(replay.countFlips([]), 0);
});

test("a stray is each entry into a cell the player is not in", () => {
  const right = new Set([4]);
  assert.strictEqual(replay.countStrays([4, 5, 5, 4, 5, null, 5, 3], right), 3);
  // A right set that changes over time, as in a step.
  const byIndex = (i) => (i < 3 ? new Set([4]) : new Set([4, 7]));
  assert.strictEqual(replay.countStrays([4, 7, 4, 7, 7], byIndex), 1);
});

test("latency runs from the crossing to the last move onto the new cell", () => {
  const times = [0, 100, 200, 300, 400, 500];
  assert.strictEqual(replay.moveLatency(times, [4, 4, 7, 4, 7, 7], 7, 150), 250);
  // Already there before the crossing, and stayed: no wait at all.
  assert.strictEqual(replay.moveLatency(times, [7, 7, 7, 7, 7, 7], 7, 150), 0);
  // Not on the new cell at the end, or in the gap: missed.
  assert.strictEqual(replay.moveLatency(times, [4, 7, 7, 7, 7, 4], 7, 150), null);
  assert.strictEqual(replay.moveLatency(times, [4, 7, 7, 7, 7, null], 7, 150), null);
});

test("a still player mid-cell on the ideal rig: every cell right, none flipping", () => {
  const { frames, play } = replay.simulate({
    site: SITE, method: null, tune: null, rig: replay.RIGS.ideal, seed: 7,
    durationMs: replay.LOCK_ON_MS + 6000, path: replay.stillPath(75, 85),
  });
  const right = play.cellsNear(75, 85);
  assert.deepStrictEqual([...right], [4]);
  const scores = replay.scoreStill(frames, right);
  ["shown", "voted", "raw"].forEach((signal) => {
    assert.strictEqual(scores[signal].flips, 0, signal);
    assert.strictEqual(scores[signal].wrong, 0, signal);
    assert.ok(scores[signal].none < scores[signal].frames / 10, signal);
  });
});
