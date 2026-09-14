"""
Tests for filterRules.py.

Two kinds:

  * Parity - replays the stream in fixtures/js_parity_trace.json, which was
    recorded by running the real game.js headless, and requires filterRules.py
    to produce the same output at every step. This is what makes the Python
    pipeline a port rather than a guess. Regenerate the fixture with
    `node Website/tests/generate_parity_trace.js` whenever a JS rule changes.

  * Behaviour - one focused test per rule, including branches the recorded
    stream does not reach.

Standard library only:

    python -m unittest discover -s Website/tests
"""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from filterRules import (  # noqa: E402
    STATUS_NO_SIGNAL,
    STATUS_OK,
    STATUS_OUT_OF_BOUNDS,
    STATUS_TOO_CLOSE,
    CartesianGeometry,
    CellStabiliser,
    ChannelFilter,
    CoordinatePipeline,
    FilterConfig,
    MajorityWindowHold,
    PlayArea,
    ProximityGuard,
    StreakHold,
    UltrasonicArrayGeometry,
)

FIXTURE = os.path.join(HERE, "fixtures", "js_parity_trace.json")


class ParityWithGameJs(unittest.TestCase):
    """filterRules.py must reproduce game.js on a recorded stream."""

    @classmethod
    def setUpClass(cls):
        with open(FIXTURE, encoding="utf-8") as fh:
            cls.trace = json.load(fh)

    def _replay(self, run_name):
        run = self.trace["runs"][run_name]
        fields = self.trace["fields"]
        area = (PlayArea.calibrated(run["calibration"]) if run["calibration"]
                else PlayArea.default())
        pipeline = CoordinatePipeline(UltrasonicArrayGeometry(), area=area)

        for i, (reading, expected_row) in enumerate(zip(self.trace["stream"], run["steps"])):
            expected = dict(zip(fields, expected_row))
            now_ms = (i + 1) * self.trace["stepMs"]
            got = pipeline.update(reading, now_ms)
            where = f"{run_name} step {i}, reading {reading}"

            self.assertEqual(got.status, expected["status"], where)
            self.assertEqual((got.gx, got.gy), (expected["gx"], expected["gy"]), where)
            self.assertEqual(got.column, expected["column"], where)
            self.assertEqual(got.held, bool(expected["held"]), where)
            self.assertEqual(got.held_for, expected["heldFor"], where)
            # The raw cell is only reported on a fresh, un-held ok.
            if got.status == STATUS_OK and not got.held:
                self.assertEqual((got.raw_gx, got.raw_gy),
                                 (expected["rawGx"], expected["rawGy"]), where)
            for channel, (a, b) in enumerate(zip(got.filtered, expected["filtered"])):
                if b is None:
                    self.assertIsNone(a, f"{where}, channel {channel}")
                else:
                    self.assertAlmostEqual(a, b, places=9, msg=f"{where}, channel {channel}")
        return len(run["steps"])

    def test_default_bounds(self):
        self.assertGreater(self._replay("default"), 0)

    def test_calibrated_bounds(self):
        self.assertGreater(self._replay("calibrated"), 0)

    def test_fixture_covers_every_branch_it_claims(self):
        seen = {(row[0], bool(row[6])) for run in self.trace["runs"].values()
                for row in run["steps"]}
        for needed in [(STATUS_OK, False), (STATUS_OK, True),
                       (STATUS_TOO_CLOSE, False), (STATUS_OUT_OF_BOUNDS, False)]:
            self.assertIn(needed, seen, f"fixture never exercises {needed}")


class ChannelFilterRules(unittest.TestCase):

    def setUp(self):
        self.cfg = FilterConfig()
        self.ch = ChannelFilter(self.cfg)

    def test_median_rejects_a_single_spike_inside_the_gate(self):
        for t, v in enumerate([70, 71, 69, 90, 70]):   # 90 passes the gate (+20)
            out = self.ch.update(v, t * 20)
        self.assertEqual(out, 70)

    def test_impossible_jump_is_discarded(self):
        self.ch.update(70, 0)
        self.assertEqual(self.ch.update(200, 20), 70)
        self.assertEqual(self.ch.reject_count, 1)

    def test_holds_through_a_short_dropout_then_gives_up(self):
        self.ch.update(70, 0)
        self.assertEqual(self.ch.update(None, self.cfg.hold_ms), 70)
        self.assertIsNone(self.ch.update(None, self.cfg.hold_ms + 1))

    def test_relocks_when_rejects_agree_with_each_other(self):
        self.ch.update(70, 0)
        t = 0
        results = []
        for _ in range(self.cfg.relock_readings):
            t += 20
            results.append(self.ch.update(200 + (t % 3), t))
        self.assertEqual(results[-1], 200 + (t % 3), "should have moved to the new position")


class ProximityGuardRules(unittest.TestCase):

    def test_needs_consecutive_frames(self):
        guard = ProximityGuard(FilterConfig(too_close_frames=2))
        self.assertFalse(guard.update(5, 10))
        self.assertTrue(guard.update(5, 10))
        self.assertFalse(guard.update(50, 10), "one safe reading clears it")

    def test_ignores_missing_and_negative(self):
        guard = ProximityGuard(FilterConfig(too_close_frames=1))
        self.assertFalse(guard.update(None, 10))
        self.assertFalse(guard.update(-1, 10))

    def test_pipeline_uses_raw_not_filtered_for_safety(self):
        # A long run of safe readings fills the median window. One raw reading
        # under the threshold must still count toward the alert immediately.
        pipe = CoordinatePipeline(UltrasonicArrayGeometry(),
                                  config=FilterConfig(too_close_frames=1))
        for i in range(20):
            pipe.update([None, 70, None], i * 20)
        self.assertEqual(pipe.update([None, 5, None], 420).status, STATUS_TOO_CLOSE)


class PlayAreaRules(unittest.TestCase):

    def test_uncalibrated_limits(self):
        area = PlayArea.default()
        self.assertEqual(area.alert_threshold_cm, 10)
        self.assertEqual(area.max_cm, 150)

    def test_calibrated_limits_never_less_cautious_than_the_floor(self):
        area = PlayArea.calibrated([(12, 140), (12, 140), (12, 140)])
        self.assertEqual(area.alert_threshold_cm, 10, "near - 15 would be -3")

    def test_shallow_column_falls_back_to_defaults(self):
        area = PlayArea.calibrated([(20, 30), (20, 140), (20, 140)])
        self.assertFalse(area.is_calibrated)

    def test_row_hysteresis_holds_near_a_boundary(self):
        area = PlayArea.default()                      # rows split at 60 and 100
        self.assertEqual(area.row_for(0, 102, previous_row=1), 1, "within 6 cm")
        self.assertEqual(area.row_for(0, 110, previous_row=1), 2, "clear of it")


class CellStabiliserRules(unittest.TestCase):

    def test_first_lock_on_is_immediate(self):
        stab = CellStabiliser(FilterConfig())
        self.assertEqual(stab.vote(1, 1), (1, 1))

    def test_rival_needs_a_clear_majority(self):
        cfg = FilterConfig(cell_window=5, cell_votes=3)
        stab = CellStabiliser(cfg)
        stab.vote(0, 0)
        self.assertEqual(stab.vote(2, 2), (0, 0))
        self.assertEqual(stab.vote(2, 2), (0, 0))
        self.assertEqual(stab.vote(2, 2), (2, 2))

    def test_tie_breaks_like_the_js_running_count(self):
        cfg = FilterConfig(cell_window=4, cell_votes=3)
        stab = CellStabiliser(cfg)
        for cell in [(0, 0), (1, 1), (1, 1), (0, 0)]:
            stab.vote(*cell)
        # Running counts reach 2 for (1,1) before (0,0), so (1,1) wins the tie
        # - but it has 2 votes, short of cell_votes, so the lock stays put.
        self.assertEqual(stab.cell, (0, 0))

    def test_rejects_a_vote_threshold_that_allows_flicker(self):
        with self.assertRaises(ValueError):
            FilterConfig(cell_window=10, cell_votes=5)


class HoldPolicies(unittest.TestCase):

    def test_streak_is_blind_to_an_intermittent_fault(self):
        hold = StreakHold(FilterConfig(hold_readings=3))
        for i in range(50):
            hold.record(i % 2 == 0)
        self.assertTrue(hold.keep_holding(), "documented weakness: never trips")

    def test_majority_window_catches_an_intermittent_fault(self):
        hold = MajorityWindowHold(FilterConfig(hold_readings=10))
        for i in range(10):
            hold.record(i % 3 == 0)                   # mostly bad
        self.assertFalse(hold.keep_holding())

    def test_majority_window_waits_for_a_full_window(self):
        hold = MajorityWindowHold(FilterConfig(hold_readings=10))
        for _ in range(9):
            hold.record(False)
        self.assertTrue(hold.keep_holding())


class PipelineBehaviour(unittest.TestCase):

    def test_no_signal_when_every_sensor_is_silent(self):
        pipe = CoordinatePipeline(UltrasonicArrayGeometry(),
                                  config=FilterConfig(hold_readings=1))
        result = None
        for i in range(10):
            result = pipe.update([None, None, None], i * 20)
        self.assertEqual(result.status, STATUS_NO_SIGNAL)

    def test_coordinate_is_in_centimetres(self):
        pipe = CoordinatePipeline(UltrasonicArrayGeometry())
        result = pipe.update([None, 70, None], 0)
        self.assertEqual((result.x_cm, result.y_cm), (75.0, 70))
        self.assertEqual((result.gx, result.gy), (1, 1))

    def test_to_dict_is_json_serialisable(self):
        pipe = CoordinatePipeline(UltrasonicArrayGeometry())
        json.dumps(pipe.update([None, 70, None], 0).to_dict())

    def test_reset_clears_everything(self):
        pipe = CoordinatePipeline(UltrasonicArrayGeometry())
        pipe.update([None, 70, None], 0)
        pipe.reset()
        self.assertEqual(pipe.update([None, None, None], 20).status, STATUS_NO_SIGNAL)


class CartesianGeometryBehaviour(unittest.TestCase):
    """The entry point for a rig that reports (x, y) itself."""

    def setUp(self):
        self.pipe = CoordinatePipeline(CartesianGeometry())

    def test_passes_a_position_through(self):
        result = self.pipe.update((120.0, 90.0), 0)
        self.assertEqual(result.status, STATUS_OK)
        self.assertEqual((result.x_cm, result.y_cm), (120.0, 90.0))
        self.assertEqual((result.gx, result.gy), (2, 1))

    def test_x_off_the_board_is_out_of_bounds(self):
        self.pipe = CoordinatePipeline(CartesianGeometry(),
                                       config=FilterConfig(hold_readings=0))
        self.assertEqual(self.pipe.update((-40.0, 80.0), 0).status, STATUS_OUT_OF_BOUNDS)

    def test_depth_drives_the_proximity_alert(self):
        self.pipe = CoordinatePipeline(CartesianGeometry(),
                                       config=FilterConfig(too_close_frames=1))
        self.assertEqual(self.pipe.update((75.0, 4.0), 0).status, STATUS_TOO_CLOSE)

    def test_missing_position_is_no_signal(self):
        self.pipe = CoordinatePipeline(CartesianGeometry(),
                                       config=FilterConfig(hold_readings=0))
        self.assertEqual(self.pipe.update(None, 0).status, STATUS_NO_SIGNAL)


if __name__ == "__main__":
    unittest.main()
