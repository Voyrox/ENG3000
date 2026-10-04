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
import math
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
    DynamicPicker,
    FilterConfig,
    MajorityWindowHold,
    OFF_BOARD,
    PlayArea,
    ProximityGuard,
    StreakHold,
    TwoSensorGeometry,
    UltrasonicArrayGeometry,
    body_centre_cm,
    fft_lowpass_last,
    in_beam,
    in_sensor_range,
    line_of_sight,
    scanner_point,
)
from tracking import ConstantVelocityTracker  # noqa: E402

FIXTURE = os.path.join(HERE, "fixtures", "js_parity_trace.json")
SILENT = "silent"   # generate_parity_trace.js: the node sent nothing this step


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
        pipeline = CoordinatePipeline(TwoSensorGeometry(method=run["method"]), area=area)

        # A node that is "silent" for a step sent nothing: its last reading
        # stands, as the server keeps it, and the recorded fresh mask (what
        # game.js worked out from last_seen) says it is not new.
        latest = [None, None, None]
        for i, (reading, expected_row) in enumerate(zip(self.trace["stream"], run["steps"])):
            expected = dict(zip(fields, expected_row))
            now_ms = (i + 1) * self.trace["stepMs"]
            for slot, entry in enumerate(reading):
                if entry != SILENT:
                    latest[slot] = entry
            fresh = [bool(f) for f in expected["fresh"]]
            got = pipeline.update(list(latest), now_ms, fresh=fresh)
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
            # Where the player was placed, by the run's method.
            if got.status == STATUS_OK:
                self.assertAlmostEqual(got.x_cm, expected["x"], delta=2e-6, msg=f"{where}, x")
                self.assertAlmostEqual(got.y_cm, expected["y"], delta=2e-6, msg=f"{where}, y")
            # And which method placed them: the run's own, or the one Dynamic
            # followed.
            self.assertEqual(pipeline.geometry.placed_by(got.filtered, area),
                             run["placedBy"][i], f"{where}, placed by")
        return len(run["steps"])

    def test_default_bounds(self):
        self.assertGreater(self._replay("default"), 0)

    def test_calibrated_bounds(self):
        self.assertGreater(self._replay("calibrated"), 0)

    def test_trilateration(self):
        self.assertGreater(self._replay("trilateration"), 0)

    def test_average_of_line_of_sight_and_trilateration(self):
        self.assertGreater(self._replay("average"), 0)

    def test_dynamic(self):
        self.assertGreater(self._replay("dynamic"), 0)

    def test_dynamic_on_calibrated_bounds(self):
        self.assertGreater(self._replay("dynamicCalibrated"), 0)

    def test_dynamic_follows_every_method_somewhere_on_the_recorded_stream(self):
        # Otherwise the parity above would not show the picker agreeing.
        for run in ("dynamic", "dynamicCalibrated"):
            followed = set(self.trace["runs"][run]["placedBy"])
            self.assertEqual(followed, {"los", "tri", "avg"}, run)

    def test_the_methods_really_differ_on_the_recorded_stream(self):
        runs = self.trace["runs"]
        at = self.trace["fields"].index("x")
        differ = sum(1 for a, b in zip(runs["default"]["steps"], runs["trilateration"]["steps"])
                     if a[at] is not None and b[at] is not None and abs(a[at] - b[at]) > 1.0)
        self.assertGreater(differ, 50, "line of sight and trilateration should not agree everywhere")

    def test_the_stream_has_turns_where_a_node_is_silent(self):
        fresh = self.trace["fields"].index("fresh")
        stale = [row for row in self.trace["runs"]["default"]["steps"] if 0 in (row[fresh][0], row[fresh][2])]
        self.assertGreater(len(stale), 100)

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
        # The median never passes the 90 on; the Kalman after it follows the
        # median (70, 71, 70, 71, 70), so the value stays by 70.
        self.assertAlmostEqual(out, 70, delta=1.0)

    def test_a_steady_reading_comes_through_every_stage_unchanged(self):
        for t in range(3 * self.cfg.fft_window):
            out = self.ch.update(70.0, t * 20)
        self.assertAlmostEqual(out, 70.0, places=9)

    def test_a_new_bearing_starts_the_channel_again(self):
        # Five readings at 90 degrees, then the servo turns: the 120 cm at the
        # new bearing is not another sample of the 50 cm track, so neither the
        # slew gate nor the median holds it back.
        for t in range(5):
            self.ch.update(50.0, t * 20, angle=90.0)
        self.assertEqual(self.ch.update(120.0, 100, angle=110.0), 120.0)
        # The same bearing again is the same track: a jump is gated as ever.
        self.assertEqual(self.ch.update(200.0, 120, angle=110.0), 120.0)

    def test_a_steady_walk_is_followed_without_wrap_lag(self):
        # 1 cm per reading. The median lags a ramp by two readings; the Kalman
        # and the FFT stage (trend removed, window mirrored) add next to
        # nothing. Taking only the mean out, as the server once did, put the
        # value around half the FFT window behind.
        for t in range(3 * self.cfg.fft_window):
            out = self.ch.update(60.0 + t, t * 20)
        truth = 60.0 + (3 * self.cfg.fft_window - 1)
        self.assertLess(abs(truth - out), 3.0)

    def test_the_kalman_takes_the_median_and_the_fft_stage_can_be_turned_off(self):
        ch = ChannelFilter(FilterConfig(fft_window=0))
        tracker = ConstantVelocityTracker()
        window = []
        for t, v in enumerate([70, 74, 69, 72, 75, 71, 73, 70, 76, 72]):
            window = (window + [v])[-self.cfg.median_window:]
            expected = tracker.update(sorted(window)[len(window) // 2], t * 20 / 1000.0)
            self.assertAlmostEqual(ch.update(v, t * 20), expected, places=12)

    def test_the_fft_stage_runs_once_the_window_has_enough_readings(self):
        readings = [70, 74, 69, 72, 75, 71, 73, 70, 76, 72, 71, 74]
        plain = ChannelFilter(FilterConfig(fft_window=0))
        smoothed = ChannelFilter(self.cfg)
        for t, v in enumerate(readings):
            a = plain.update(v, t * 20)
            b = smoothed.update(v, t * 20)
            if t + 1 < self.cfg.fft_min_samples:
                self.assertEqual(a, b, f"reading {t}: the FFT stage has too little to work on")
        self.assertNotAlmostEqual(a, b, places=6)

    def test_a_negative_channel_value_is_a_reading_not_a_miss(self):
        # An x coordinate can be left of the play area.
        self.assertEqual(self.ch.update(-40.0, 0), -40.0)

    def test_impossible_jump_is_discarded(self):
        self.ch.update(70, 0)
        self.assertEqual(self.ch.update(200, 20), 70)
        self.assertEqual(self.ch.reject_count, 1)

    def test_holds_through_a_short_dropout_then_gives_up(self):
        self.ch.update(70, 0)
        self.assertEqual(self.ch.update(None, self.cfg.hold_ms), 70)
        self.assertIsNone(self.ch.update(None, self.cfg.hold_ms + 1))

    def test_relock_restarts_the_smoothing(self):
        for t in range(20):
            self.ch.update(70.0, t * 20)
        t = 20 * 20
        for _ in range(self.cfg.relock_readings):
            t += 20
            out = self.ch.update(200.0, t)
        self.assertEqual(out, 200.0, "no Kalman or FFT memory of 70 after the re-lock")

    def test_a_channel_starts_again_after_a_silence(self):
        # The node's scanning turn ended; it comes back 1 s later, 80 cm on.
        # The gate would turn an 80 cm jump away, but after a silence longer
        # than the hold nothing it remembers describes the player any more.
        for t in range(10):
            self.ch.update(70.0, t * 20)
        self.assertEqual(self.ch.update(150.0, 9 * 20 + 1000), 150.0)
        self.assertEqual(self.ch.reject_count, 0)

    def test_relocks_when_rejects_agree_with_each_other(self):
        self.ch.update(70, 0)
        t = 0
        results = []
        for _ in range(self.cfg.relock_readings):
            t += 20
            results.append(self.ch.update(200 + (t % 3), t))
        self.assertEqual(results[-1], 200 + (t % 3), "should have moved to the new position")


class FftLowpassLast(unittest.TestCase):
    """fft_lowpass_last(), the FFT stage (fftLowpassLast() in game.js)."""

    RATE = 20.0

    def test_a_straight_line_passes_exactly(self):
        line = [12.5 + 1.75 * i for i in range(32)]
        self.assertAlmostEqual(fft_lowpass_last(line, self.RATE, 3.0), line[-1], places=9)

    def test_a_tone_above_the_cutoff_is_removed(self):
        tone = [100.0 + 5.0 * math.sin(2 * math.pi * 8.0 * i / self.RATE + 0.3) for i in range(32)]
        self.assertAlmostEqual(fft_lowpass_last(tone, self.RATE, 3.0), 100.0, delta=1.0)

    def test_a_slow_tone_under_the_cutoff_is_kept(self):
        tone = [100.0 + 5.0 * math.sin(2 * math.pi * 0.5 * i / self.RATE) for i in range(32)]
        self.assertAlmostEqual(fft_lowpass_last(tone, self.RATE, 3.0), tone[-1], delta=0.5)

    def test_one_or_two_readings_come_back_as_they_are(self):
        self.assertEqual(fft_lowpass_last([7.0], self.RATE, 3.0), 7.0)
        self.assertAlmostEqual(fft_lowpass_last([7.0, 9.0], self.RATE, 3.0), 9.0, places=9)

    def test_config_refuses_a_negative_window(self):
        with self.assertRaises(ValueError):
            FilterConfig(fft_window=-1)

    def test_the_channel_measures_the_fft_rate_from_its_readings(self):
        # A 5 Hz swing is above a 3 Hz cutoff when readings come 25 ms apart
        # (40/s, window rate measured), and the same readings 100 ms apart are
        # a 1.25 Hz swing, which passes.
        swing = [100.0 + (4.0 if i % 8 < 4 else -4.0) for i in range(40)]
        fast = ChannelFilter(FilterConfig())
        slow = ChannelFilter(FilterConfig())
        for i, value in enumerate(swing):
            a = fast.update(value, i * 25)
            b = slow.update(value, i * 100)
        self.assertLess(abs(a - 100.0), abs(b - 100.0))


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


# The player is a body: each echo comes off the side of them nearest the node,
# this far short of their middle (FilterConfig.body_radius_cm adds it back).
BODY_RADIUS_CM = FilterConfig().body_radius_cm


def scanner_sample(x_cm, y_cm, state=0, aim_error_deg=0.0):
    """[left, centre, right] scanner readings of a player whose middle is at
    (x_cm, y_cm): exact distances to the near side of them, each node's angle
    pointing at their middle (larger turns towards screen-right, as the rig's
    servos do; plus aim_error_deg), and a scan state."""
    def reading(node_x):
        angle = 90 + math.degrees(math.atan2(x_cm - node_x, y_cm)) + aim_error_deg
        return (math.hypot(x_cm - node_x, y_cm) - BODY_RADIUS_CM, angle, state)
    return [reading(25.0), None, reading(125.0)]


def two_sensor_sample(x_cm, depth_cm):
    """[left, centre, right] distances a player whose middle is at (x, depth)
    would produce (to the near side of them), with the sensors at the centres
    of the outer columns (25 and 125 cm)."""
    return [math.hypot(x_cm - 25.0, depth_cm) - BODY_RADIUS_CM, None,
            math.hypot(x_cm - 125.0, depth_cm) - BODY_RADIUS_CM]


class DynamicPickerBehaviour(unittest.TestCase):
    """Dynamic: the method that has held its square longest places the player."""

    # Squares on the default board (columns 50 cm wide, rows 40 cm deep from
    # 20 cm out): A is the near-left cell, B the middle, C the far-right.
    A = (25.0, 40.0)
    B = (75.0, 80.0)
    C = (125.0, 120.0)

    def setUp(self):
        self.picker = DynamicPicker()
        self.area = PlayArea.default()
        self.config = FilterConfig()

    def at(self, now_ms, los, tri, avg):
        """Steps the picker with these positions and returns its leader."""
        fixes = {"los": los, "tri": tri, "avg": avg}
        self.picker.step(fixes, now_ms, self.area)
        return self.picker.leader(fixes, now_ms, self.config)

    def test_squares_are_the_cells_of_the_board(self):
        self.assertEqual(DynamicPicker.square_of(self.A, self.area), 0)
        self.assertEqual(DynamicPicker.square_of(self.B, self.area), 4)
        self.assertEqual(DynamicPicker.square_of(self.C, self.area), 8)
        self.assertIsNone(DynamicPicker.square_of(None, self.area))

    def test_off_the_board_is_a_square_of_its_own(self):
        for where in ((-5.0, 80.0), (155.0, 80.0), (75.0, 400.0)):
            self.assertEqual(DynamicPicker.square_of(where, self.area), OFF_BOARD, where)

    def test_follows_the_method_that_has_held_its_square_longest(self):
        self.at(0, self.A, self.A, self.A)
        # Line of sight moves; the other two have held A for 200 ms, and
        # trilateration comes before the average.
        self.assertEqual(self.at(200, self.B, self.A, self.A), "tri")
        self.assertEqual(self.at(300, self.B, self.A, self.B), "tri")

    def test_a_method_that_keeps_changing_square_is_passed_over(self):
        self.at(0, self.A, self.C, self.B)
        for step in range(1, 20):
            los = self.B if step % 2 else self.A   # bounces every 100 ms
            self.assertEqual(self.at(step * 100, los, self.C, self.B), "tri", step)

    def test_past_the_steady_time_line_of_sight_wins(self):
        self.at(0, self.A, self.C, self.C)
        self.at(500, self.B, self.C, self.C)
        # Trilateration has held C 1.4 s, but counts only 1 s; line of sight
        # has held B 0.9 s.
        self.assertEqual(self.at(1400, self.B, self.C, self.C), "tri")
        # Both fully steady: line of sight first.
        self.assertEqual(self.at(1500, self.B, self.C, self.C), "los")
        self.assertEqual(self.at(9000, self.B, self.C, self.C), "los")

    def test_the_steady_time_is_tunable(self):
        self.config = FilterConfig(dynamic_steady_ms=2000.0)
        self.at(0, self.A, self.C, self.C)
        self.at(500, self.B, self.C, self.C)
        self.assertEqual(self.at(1500, self.B, self.C, self.C), "tri")
        self.assertEqual(self.at(2500, self.B, self.C, self.C), "los")

    def test_a_method_with_no_position_is_out_of_the_running(self):
        self.at(0, self.A, self.C, self.C)
        self.assertEqual(self.at(300, None, self.C, self.C), "tri")
        # Back in A, line of sight starts its time again from 400 ms.
        self.assertEqual(self.at(400, self.A, self.C, self.C), "tri")
        self.assertEqual(self.at(1300, self.A, self.C, self.C), "tri")
        self.assertEqual(self.at(1400, self.A, self.C, self.C), "los")
        self.assertIsNone(self.at(1500, None, None, None))

    def test_an_unstepped_position_has_been_held_for_no_time(self):
        # As just after a reset: line of sight first, as on a tie.
        fixes = {"los": self.A, "tri": self.C, "avg": self.B}
        self.assertEqual(self.picker.leader(fixes, 0, self.config), "los")
        fixes["los"] = None
        self.assertEqual(self.picker.leader(fixes, 0, self.config), "tri")

    def test_reset_forgets_every_square(self):
        self.at(0, self.A, self.C, self.C)
        self.at(500, self.B, self.C, self.C)
        self.picker.reset()
        self.assertEqual(self.at(600, self.B, self.C, self.C), "los")


class DynamicPositionMethod(unittest.TestCase):
    """TwoSensorGeometry's "dyn": the position comes from the method it follows."""

    def test_dynamic_is_the_default(self):
        self.assertEqual(TwoSensorGeometry().method, "dyn")

    def test_an_unknown_method_is_refused(self):
        with self.assertRaises(ValueError):
            TwoSensorGeometry(method="steady")

    def test_the_position_is_the_one_dynamic_follows(self):
        pipe = CoordinatePipeline(TwoSensorGeometry(method="dyn"))
        geometry = pipe.geometry
        for step in range(40):
            got = pipe.update(scanner_sample(70.0 + (step % 3), 90.0), step * 50.0)
            fixes = geometry.fixes(got.filtered, pipe.area)
            follows = geometry.placed_by(got.filtered, pipe.area)
            self.assertIn(follows, ("los", "tri", "avg"), step)
            self.assertEqual(fixes["dyn"], fixes[follows], step)
            if got.status == STATUS_OK and not got.held:
                self.assertAlmostEqual(got.x_cm, min(max(fixes[follows][0], 0.0), 150.0), msg=step)

    def test_another_method_is_placed_by_itself(self):
        geometry = TwoSensorGeometry(method="tri")
        self.assertEqual(geometry.placed_by([None] * 3, PlayArea.default()), "tri")


class TwoSensorGeometryBehaviour(unittest.TestCase):
    """Today's rig: LEFT and RIGHT sensors, basic trilateration."""

    def setUp(self):
        self.geometry = TwoSensorGeometry()
        self.area = PlayArea.default()
        self.config = FilterConfig()

    def locate(self, sample):
        return self.geometry.locate(sample, self.area, self.config)

    def test_both_sensors_place_the_player_in_the_centre_column(self):
        fix = self.locate(two_sensor_sample(75.0, 100.0))
        self.assertEqual(fix.status, STATUS_OK)
        self.assertAlmostEqual(fix.x_cm, 75.0)
        self.assertAlmostEqual(fix.y_cm, 100.0)
        self.assertEqual(fix.column, 1)

    def test_crossing_recovers_an_off_axis_position(self):
        fix = self.locate(two_sensor_sample(60.0, 80.0))
        self.assertAlmostEqual(fix.x_cm, 60.0)
        self.assertAlmostEqual(fix.y_cm, 80.0)
        self.assertEqual(fix.distance_cm, fix.y_cm)

    def test_a_wall_reading_falls_back_to_the_other_sensor(self):
        fix = self.locate([70.0, None, 235.0])
        self.assertEqual((fix.x_cm, fix.y_cm, fix.column), (25.0, 70.0 + BODY_RADIUS_CM, 0))

    def test_circles_that_miss_fall_back_to_the_nearer_sensor(self):
        # 35 + 45 cm to the middle of the player < the 100 cm between the
        # sensors: no crossing exists.
        fix = self.locate([20.0, None, 30.0])
        self.assertEqual((fix.x_cm, fix.y_cm, fix.column), (25.0, 20.0 + BODY_RADIUS_CM, 0))

    def test_the_centre_channel_is_ignored(self):
        self.assertEqual(self.geometry.channels([None, 70.0, None]), [None, None, None])
        pipe = CoordinatePipeline(TwoSensorGeometry(), config=FilterConfig(hold_readings=0))
        self.assertEqual(pipe.update([None, 70.0, None], 0).status, STATUS_NO_SIGNAL)

    def test_column_holds_next_to_a_boundary(self):
        self.assertEqual(self.locate(two_sensor_sample(45.0, 90.0)).column, 0)
        # 52 cm is past the 50 cm boundary but inside the 8 cm margin.
        self.assertEqual(self.locate(two_sensor_sample(52.0, 90.0)).column, 0)
        self.assertEqual(self.locate(two_sensor_sample(60.0, 90.0)).column, 1)

    def test_beyond_the_far_limit_is_out_of_bounds(self):
        fix = self.locate([None, None, 170.0])
        self.assertEqual(fix.status, STATUS_OUT_OF_BOUNDS)

    def test_off_either_side_of_the_board_is_out_of_bounds(self):
        # Every method, each on its own geometry (a line-of-sight track would
        # carry over). 80 cm (95 to the player's middle) from the left scanner
        # at 50 degrees: x = 25 - 95 sin 40 = -36.
        for method in ("los", "tri", "avg"):
            left = self.scan([(80.0, 50), None, None], geometry=TwoSensorGeometry(method=method))
            self.assertEqual(left.status, STATUS_OUT_OF_BOUNDS, method)
            self.assertEqual(left.x_cm, 0.0, method)  # clamped for the column, still out
            # From the right scanner at 130 degrees: x = 125 + 95 sin 40 = 186.
            right = self.scan([None, None, (80.0, 130)], geometry=TwoSensorGeometry(method=method))
            self.assertEqual(right.status, STATUS_OUT_OF_BOUNDS, method)

    def test_just_inside_the_side_edge_is_in_bounds(self):
        # 80 cm (95 to the middle) from the left scanner at 75 degrees:
        # x = 25 - 95 sin 15 = 0.4.
        for method in ("los", "tri", "avg"):
            fix = self.scan([(80.0, 75), None, None], geometry=TwoSensorGeometry(method=method))
            self.assertEqual(fix.status, STATUS_OK, method)

    # --- servo scanners: (distance, angle) per node ---------------------------

    def test_a_scanner_at_90_degrees_points_straight_out(self):
        self.assertEqual(scanner_point(25.0, 80.0, 90), (25.0, 80.0))

    def test_a_larger_angle_turns_towards_screen_right(self):
        # As the rig's servos turn (the centre test, 4 Oct 2026).
        x, y = scanner_point(25.0, 80.0, 120)
        self.assertAlmostEqual(x, 65.0)
        self.assertAlmostEqual(y, 80.0 * math.cos(math.radians(30)))
        x, _ = scanner_point(125.0, 80.0, 60)
        self.assertAlmostEqual(x, 85.0)

    def test_the_body_radius_is_added_to_every_distance(self):
        # A player straight out from the left node: the echo comes off the
        # near side of them, and the fix is their middle.
        config = FilterConfig(body_radius_cm=12.0)
        self.assertEqual(body_centre_cm(68.0, config), 80.0)
        for method in ("los", "tri", "avg"):
            geometry = TwoSensorGeometry(method=method)
            readings = geometry.channels([(68.0, 90, 0), None, None])
            geometry.track(readings, [True] * 3, 0.0, self.area, config)
            fix = geometry.locate(readings, self.area, config)
            self.assertEqual((fix.x_cm, fix.y_cm), (25.0, 80.0), method)

    # --- the position methods, which need track() before locate() ----------

    def scan(self, sample, now_ms=0.0, fresh=(True, True, True), geometry=None):
        """One update as the pipeline runs it, on unfiltered readings."""
        geometry = geometry or self.geometry
        readings = geometry.channels(sample)
        geometry.track(readings, list(fresh), now_ms, self.area, self.config)
        return geometry.locate(readings, self.area, self.config)

    def test_two_scanners_on_the_same_point_put_the_player_there(self):
        fix = self.scan(scanner_sample(75.0, 80.0))
        self.assertAlmostEqual(fix.x_cm, 75.0, places=6)
        self.assertAlmostEqual(fix.y_cm, 80.0, places=6)
        self.assertEqual(fix.column, 1)

    def test_one_scanner_hearing_nothing_leaves_the_other(self):
        fix = self.scan([(None, 110, 2), None, (90.0, 65, 0)])
        x, y = scanner_point(125.0, body_centre_cm(90.0, self.config), 65)
        self.assertAlmostEqual(fix.x_cm, x)
        self.assertAlmostEqual(fix.y_cm, y)

    def test_line_of_sight_leaves_out_a_node_that_is_sweeping(self):
        # The left node is lost, and its beam has found furniture at 120 cm.
        sample = scanner_sample(80.0, 95.0)
        sample[0] = (120.0, 120, 2)
        fix = self.scan(sample)
        x, y = scanner_point(125.0, body_centre_cm(sample[2][0], self.config), sample[2][1])
        self.assertAlmostEqual(fix.x_cm, x)
        self.assertAlmostEqual(fix.y_cm, y)
        # Trilateration does not know the node is lost. Here the circles cross
        # inside both beams (the left one points close to the crossing), so
        # even the beam check lets it take the furniture's distance.
        tri = self.scan(sample, geometry=TwoSensorGeometry(method="tri"))
        self.assertGreater(math.dist((tri.x_cm, tri.y_cm), (80.0, 95.0)), 10.0)

    def test_trilateration_crosses_the_distances_inside_both_beams(self):
        geometry = TwoSensorGeometry(method="tri")
        # 5 degrees off each aim is inside the 7.5-degree half-beam: the
        # crossing of the two distances is taken, not the angles.
        fix = self.scan(scanner_sample(60.0, 80.0, aim_error_deg=5.0), geometry=geometry)
        self.assertAlmostEqual(fix.x_cm, 60.0)
        self.assertAlmostEqual(fix.y_cm, 80.0)

    def test_trilateration_refuses_a_crossing_outside_a_beam(self):
        geometry = TwoSensorGeometry(method="tri")
        # Both servos point somewhere else entirely: the crossing is not where
        # the left one is looking, so the nearer node (left, 87 cm to the
        # player's middle) places the player by its own distance along its own
        # aim instead.
        d_left = math.hypot(60 - 25, 80) - BODY_RADIUS_CM
        sample = [(d_left, 60, 0), None, (math.hypot(60 - 125, 80) - BODY_RADIUS_CM, 60, 0)]
        fix = self.scan(sample, geometry=geometry)
        x, y = scanner_point(25.0, body_centre_cm(d_left, self.config), 60)
        self.assertAlmostEqual(fix.x_cm, max(0.0, x))
        self.assertAlmostEqual(fix.y_cm, y)

    def test_one_node_aimed_away_leaves_the_crossing_to_the_other(self):
        # The right node looks 25 degrees past the player (furniture, say),
        # further than its beam and the player's width reach: the crossing is
        # refused, and the left node - nearer, and aimed at the player - puts
        # them where it sees them.
        geometry = TwoSensorGeometry(method="tri")
        sample = scanner_sample(60.0, 80.0)
        sample[2] = (sample[2][0], sample[2][1] - 25.0, 0)
        fix = self.scan(sample, geometry=geometry)
        self.assertAlmostEqual(fix.x_cm, 60.0)
        self.assertAlmostEqual(fix.y_cm, 80.0)

    def test_trilateration_without_angles_uses_the_distances_alone(self):
        # Firmware from before the scanner sends no angle: nothing to check.
        geometry = TwoSensorGeometry(method="tri")
        fix = self.scan(two_sensor_sample(60.0, 80.0), geometry=geometry)
        self.assertAlmostEqual(fix.x_cm, 60.0)
        self.assertAlmostEqual(fix.y_cm, 80.0)

    def test_the_half_beam_is_tunable(self):
        geometry = TwoSensorGeometry(method="tri")
        sample = scanner_sample(60.0, 80.0, aim_error_deg=5.0)
        narrow = FilterConfig(tri_beam_half_deg=4.0, body_half_width_cm=0.0)
        readings = geometry.channels(sample)
        geometry.track(readings, [True] * 3, 0.0, self.area, narrow)
        fix = geometry.locate(readings, self.area, narrow)
        # 5 degrees off is outside 4: the left node's own aim, not the crossing.
        x, y = scanner_point(25.0, body_centre_cm(sample[0][0], narrow), sample[0][1])
        self.assertAlmostEqual(fix.x_cm, x)
        self.assertAlmostEqual(fix.y_cm, y)

    def test_in_beam_measures_the_angle_off_the_aim(self):
        # Straight out (90) from x = 25: a point 7 degrees off is in, 8 is out.
        for off_deg, inside in ((0, True), (7, True), (-7, True), (8, False), (-8, False)):
            x = 25.0 - 100 * math.sin(math.radians(off_deg))
            y = 100 * math.cos(math.radians(off_deg))
            self.assertEqual(in_beam(25.0, 90, x, y, 7.5), inside, off_deg)
        self.assertTrue(in_beam(25.0, None, 140.0, 5.0, 7.5))   # no angle, no check
        self.assertFalse(in_beam(25.0, 90, 25.0, -10.0, 7.5))   # behind the node

    def test_the_beam_is_widened_by_the_players_half_width(self):
        # 100 cm straight out from x = 25 the beam's edge is 13.2 cm to the
        # side; the middle of the player can be 20 cm past it when the beam
        # found the edge of them.
        edge = 100 * math.tan(math.radians(7.5))
        for side, body, inside in ((edge + 19.0, 20.0, True), (edge + 21.0, 20.0, False),
                                   (edge + 1.0, 0.0, False)):
            for x in (25.0 + side, 25.0 - side):
                self.assertEqual(in_beam(25.0, 90, x, 100.0, 7.5, body), inside, (side, body))

    def test_a_distance_outside_the_sensor_range_is_not_a_reading(self):
        self.assertFalse(in_sensor_range(None))
        self.assertFalse(in_sensor_range(1.5))
        self.assertTrue(in_sensor_range(2.0))
        self.assertTrue(in_sensor_range(400.0))
        self.assertFalse(in_sensor_range(400.5))

    def test_average_is_the_midpoint_of_the_other_two(self):
        sample = scanner_sample(80.0, 95.0)
        sample[0] = (120.0, 120, 0)     # the left node aimed at something else
        fixes = {}
        for method in ("los", "tri", "avg"):
            geometry = TwoSensorGeometry(method=method)
            fix = self.scan(sample, geometry=geometry)
            fixes[method] = (fix.x_cm, fix.y_cm)
        # x is clamped to the board by locate(); these all lie on it.
        self.assertAlmostEqual(fixes["avg"][0], (fixes["los"][0] + fixes["tri"][0]) / 2)
        self.assertAlmostEqual(fixes["avg"][1], (fixes["los"][1] + fixes["tri"][1]) / 2)

    def test_a_node_whose_reading_is_not_new_is_not_fed_to_the_track(self):
        self.scan(scanner_sample(40.0, 70.0), now_ms=0.0)
        # The right node's last reading is repeated but not new (the left
        # node's turn); even a distance that no longer fits is not taken.
        sample = scanner_sample(40.0, 72.0)
        sample[2] = (30.0, 90, 0)
        fix = self.scan(sample, now_ms=50.0, fresh=(True, True, False))
        self.assertLess(abs(fix.x_cm - 40.0), 3.0)
        self.assertLess(abs(fix.y_cm - 72.0), 3.0)

    def test_while_the_servos_hold_still_the_distances_pin_the_player_down(self):
        # Both servos hold an aim 5 degrees off; the distances are exact. Each
        # aim alone puts the player some 7-10 cm out, but a held aim counts for
        # less with every reading while the distances count in full, and the
        # distances cross where the player is.
        truth = (75.0, 90.0)
        sample = scanner_sample(*truth, aim_error_deg=5.0)
        aimed = [scanner_point(node_x, body_centre_cm(sample[slot][0], self.config), sample[slot][1])
                 for slot, node_x in ((0, 25.0), (2, 125.0))]
        off = max(math.dist(point, truth) for point in aimed)
        self.assertGreater(off, 7.0)
        for k in range(40):
            fix = self.scan(sample, now_ms=50.0 * k)
        self.assertLess(math.dist((fix.x_cm, fix.y_cm), truth), 1.0)

    def test_readings_far_from_the_track_are_left_out_then_taken(self):
        for k in range(10):
            self.scan(scanner_sample(40.0, 70.0), now_ms=50.0 * k)
        # One node's readings only, so each update is one outlier.
        relock = self.config.los_relock_readings
        for k in range(relock):
            fix = self.scan(scanner_sample(120.0, 60.0), now_ms=500.0 + 50.0 * k,
                            fresh=(True, True, False))
            if k < relock - 1:
                self.assertLess(fix.x_cm, 60.0, f"outlier {k + 1} of {relock} moved the track")
        self.assertAlmostEqual(fix.x_cm, 120.0, delta=1.0)

    def test_the_track_is_dropped_when_nothing_usable_arrives(self):
        # The track's own timeout, so not the nobody-found rule, which would
        # otherwise end it at the same moment.
        self.config = FilterConfig(nobody_found_ms=math.inf)
        self.scan(scanner_sample(40.0, 70.0), now_ms=0.0)
        lost = [(None, 60, 2), None, (None, 120, 2)]
        timeout = self.config.los_track_timeout_ms
        self.assertEqual(self.scan(lost, now_ms=timeout).status, STATUS_OK)
        self.assertEqual(self.scan(lost, now_ms=timeout + 1).status, STATUS_NO_SIGNAL)

    def test_one_nodes_readings_turned_away_restart_the_track(self):
        # Both nodes report at once. When the player turns up somewhere else,
        # the left node's new reading can still pass the gate on the slack
        # across its line (the player's width) while the right node's distance
        # says the track is far off. The right node's turned-away readings are
        # counted on their own, so the track moves within a few updates.
        for k in range(20):
            self.scan(scanner_sample(80.0, 95.0), now_ms=50.0 * k)
        for k in range(self.config.los_relock_readings + 2):
            fix = self.scan(scanner_sample(120.0, 60.0), now_ms=1000.0 + 50.0 * k)
        self.assertLess(math.dist((fix.x_cm, fix.y_cm), (120.0, 60.0)), 5.0)

    def test_an_unknown_method_is_refused(self):
        with self.assertRaises(ValueError):
            TwoSensorGeometry(method="guess")
        with self.assertRaises(ValueError):
            self.geometry.method = "guess"

    def test_the_line_of_sight_is_tight_along_and_loose_across(self):
        # Straight out from the left node: along is y, across is x. Across, the
        # aim's uncertainty at this distance and the player's half-width.
        x, y, cov = line_of_sight(25.0, 100.0, 90.0, 0, self.config)
        self.assertEqual((x, y), (25.0, 100.0))
        self.assertAlmostEqual(cov[1][1], self.config.los_range_sigma_cm ** 2)
        aim = 100.0 * math.radians(self.config.los_bearing_found_deg)
        self.assertAlmostEqual(cov[0][0], aim ** 2 + self.config.body_half_width_cm ** 2)
        _, _, point = line_of_sight(25.0, 100.0, 90.0, 0, FilterConfig(body_half_width_cm=0.0))
        self.assertAlmostEqual(point[0][0], aim ** 2)
        # Half-found is less sure of its aim than found.
        _, _, half = line_of_sight(25.0, 100.0, 90.0, 1, self.config)
        self.assertGreater(half[0][0], cov[0][0])
        # The same aim again counts a quarter as much across the line, and the
        # distance along it just as much.
        _, _, again = line_of_sight(25.0, 100.0, 90.0, 0, self.config, repeats=1)
        self.assertAlmostEqual(again[0][0], 4 * cov[0][0])
        self.assertAlmostEqual(again[1][1], cov[1][1])

    def test_without_angles_the_nodes_trilaterate(self):
        fix = self.locate(self.geometry.channels(two_sensor_sample(60.0, 80.0)))
        self.assertAlmostEqual(fix.x_cm, 60.0)
        self.assertAlmostEqual(fix.y_cm, 80.0)


class NobodyFound(unittest.TestCase):
    """Neither node finding the player (both heads) for nobody_found_ms:
    nobody is on the board (no-signal, shown as Out of bounds), with no
    hold."""

    STEP_MS = 50.0

    def run_for(self, pipe, sample, start_ms, ms):
        """Feeds the same sample every STEP_MS from start_ms; the last result."""
        result = None
        k = 0
        while k * self.STEP_MS <= ms:
            result = pipe.update(sample, start_ms + k * self.STEP_MS)
            k += 1
        return result

    def lost(self, left_echo=None):
        return [(left_echo, 60, 2), None, (None, 120, 2)]

    def test_after_nobody_found_ms_nobody_is_on_the_board(self):
        for method in ("los", "tri", "avg"):
            pipe = CoordinatePipeline(TwoSensorGeometry(method=method))
            found = self.run_for(pipe, scanner_sample(75.0, 80.0), 0.0, 1000.0)
            self.assertEqual(found.status, STATUS_OK, method)
            wait = pipe.config.nobody_found_ms
            # Just short of it, the player is still on the board (the track, or
            # the last cell ridden out).
            riding = self.run_for(pipe, self.lost(), 1000.0 + self.STEP_MS, wait - 2 * self.STEP_MS)
            self.assertEqual(riding.status, STATUS_OK, method)
            # From nobody_found_ms after the last reading that found the player:
            # nobody, and not held, though the hold's budget is far from spent.
            gone = pipe.update(self.lost(), 1000.0 + wait)
            self.assertEqual(gone.status, STATUS_NO_SIGNAL, method)
            self.assertFalse(gone.held, method)
            # Found again: back at once.
            back = self.run_for(pipe, scanner_sample(75.0, 80.0), 1000.0 + wait + self.STEP_MS, 500.0)
            self.assertEqual(back.status, STATUS_OK, method)
            self.assertFalse(back.held, method)

    def test_half_found_on_stray_echoes_is_still_nobody(self):
        # With nobody there the nodes half-find the floor and furniture: one
        # head hears something. That is not the player.
        pipe = CoordinatePipeline(TwoSensorGeometry())
        self.run_for(pipe, scanner_sample(75.0, 80.0), 0.0, 500.0)
        stray = [(120.0, 60, 1), None, (90.0, 120, 1)]
        wait = pipe.config.nobody_found_ms
        self.assertEqual(self.run_for(pipe, stray, 550.0, wait - 200.0).status, STATUS_OK)
        self.assertEqual(self.run_for(pipe, stray, 500.0 + wait, 0.0).status, STATUS_NO_SIGNAL)

    def test_a_stray_echo_while_both_sweep_is_still_nobody(self):
        # The left node's beam finds furniture while it sweeps: trilateration
        # would place it, but a sweeping node is saying it does not see the
        # player.
        pipe = CoordinatePipeline(TwoSensorGeometry(method="tri"))
        self.run_for(pipe, scanner_sample(75.0, 80.0), 0.0, 500.0)
        result = self.run_for(pipe, self.lost(left_echo=120.0), 550.0, pipe.config.nobody_found_ms)
        self.assertEqual(result.status, STATUS_NO_SIGNAL)

    def test_one_node_still_finding_the_player_is_not_nobody_found(self):
        pipe = CoordinatePipeline(TwoSensorGeometry())
        sample = scanner_sample(100.0, 70.0)
        sample[0] = (None, 60, 2)
        result = self.run_for(pipe, sample, 0.0, 3000.0)
        self.assertEqual(result.status, STATUS_OK)
        self.assertFalse(result.held)

    def test_the_node_waiting_for_its_turn_counts_by_its_last_reading(self):
        # Turns: the right node found the player on its last turn, so while
        # the left one sweeps alone, the right one is not lost yet.
        pipe = CoordinatePipeline(TwoSensorGeometry())
        self.run_for(pipe, scanner_sample(75.0, 80.0), 0.0, 500.0)
        right_found = scanner_sample(75.0, 80.0)[2]
        result = None
        for k in range(1, 61):       # 3 s of the left node's turn
            result = pipe.update([(None, 60, 2), None, right_found], 500.0 + 50.0 * k,
                                 fresh=[True, False, False])
        self.assertNotEqual(result.status, STATUS_NO_SIGNAL)

    def test_nodes_without_a_scan_state_never_count_as_lost(self):
        geometry = TwoSensorGeometry()
        geometry.channels([(None, 60), None, (None, 120)])
        geometry.track([None] * 3, [True] * 3, 10_000.0, PlayArea.default(), FilterConfig())
        self.assertFalse(geometry._nobody_found(FilterConfig()))

    def test_the_wait_is_tunable(self):
        pipe = CoordinatePipeline(TwoSensorGeometry(), config=FilterConfig(nobody_found_ms=400.0))
        self.run_for(pipe, scanner_sample(75.0, 80.0), 0.0, 500.0)
        self.assertEqual(pipe.update(self.lost(), 900.0).status, STATUS_NO_SIGNAL)


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
