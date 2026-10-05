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
    DYNAMIC_RULE_SWITCHES,
    DynamicPicker,
    FilterConfig,
    GRID_LENGTH_CM,
    LOST_READINGS_MAX,
    MajorityWindowHold,
    OFF_BOARD,
    PlayArea,
    ProximityGuard,
    StreakHold,
    TwoSensorGeometry,
    UltrasonicArrayGeometry,
    angle_limit_cm,
    body_centre_cm,
    fft_lowpass_last,
    in_beam,
    in_sensor_range,
    line_of_sight,
    lost_score,
    scanner_point,
    within_angle_limit,
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
        # Dynamic's rule switches, as the run set them (setDynamicRules()).
        switches = run.get("dynamicRules") or {}
        config = FilterConfig(kalman=run.get("kalman", True),
                              angle_limit=run.get("angleLimit", True),
                              dead_zone=run.get("deadZone", True),
                              **{DYNAMIC_RULE_SWITCHES[name]: on for name, on in switches.items()})
        pipeline = CoordinatePipeline(TwoSensorGeometry(method=run["method"]), area=area,
                                      config=config)

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
            # Heard: the nodes that sent something this step (game.js: a new
            # last_seen stamp), so each scan state counts once.
            heard = [entry != SILENT for entry in reading]
            got = pipeline.update(list(latest), now_ms, fresh=fresh, heard=heard)
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

    def test_trilateration_with_the_far_edge_past_150_cm(self):
        self.assertGreater(self._replay("trilaterationDeep"), 0)

    def test_average_of_line_of_sight_and_trilateration(self):
        self.assertGreater(self._replay("average"), 0)

    def test_dynamic(self):
        self.assertGreater(self._replay("dynamic"), 0)

    def test_dynamic_on_calibrated_bounds(self):
        self.assertGreater(self._replay("dynamicCalibrated"), 0)

    def test_line_of_sight_with_the_kalman_off(self):
        self.assertGreater(self._replay("kalmanOff"), 0)

    def test_dynamic_with_the_kalman_off(self):
        self.assertGreater(self._replay("kalmanOffDynamic"), 0)

    def test_line_of_sight_with_the_angle_limit_off(self):
        self.assertGreater(self._replay("angleLimitOff"), 0)

    def test_dynamic_with_the_angle_limit_off(self):
        self.assertGreater(self._replay("angleLimitOffDynamic"), 0)

    def test_line_of_sight_with_the_dead_zone_off(self):
        self.assertGreater(self._replay("deadZoneOff"), 0)

    def test_dynamic_with_the_dead_zone_off(self):
        self.assertGreater(self._replay("deadZoneOffDynamic"), 0)

    def test_the_kalman_switch_changes_the_recorded_stream(self):
        # Otherwise the two runs above would not show the switch doing anything.
        runs = self.trace["runs"]
        filtered = self.trace["fields"].index("filtered")
        at = self.trace["fields"].index("x")
        smoothing = sum(1 for a, b in zip(runs["default"]["steps"], runs["kalmanOff"]["steps"])
                        if a[filtered] != b[filtered])
        placed = sum(1 for a, b in zip(runs["default"]["steps"], runs["kalmanOff"]["steps"])
                     if a[at] is not None and b[at] is not None and abs(a[at] - b[at]) > 1.0)
        self.assertGreater(smoothing, 50, "the distances should differ without the Kalman")
        self.assertGreater(placed, 50, "line of sight should place the player differently")

    def test_dynamic_with_its_rules_switched_off(self):
        self.assertGreater(self._replay("dynamicRulesOff"), 0)
        followed = set(self.trace["runs"]["dynamicRulesOff"]["placedBy"]) - {None}
        self.assertLessEqual(followed, {"los", "tri", "avg"})

    def test_dynamic_follows_every_method_and_rule_somewhere_on_the_recorded_stream(self):
        # Otherwise the parity above would not show the picker and the rules
        # agreeing. Since the centre hold, the centre rule takes the stretches
        # where the picker used to follow the average, so only two of the
        # methods are required (DynamicPickerBehaviour covers the average).
        for run in ("dynamic", "dynamicCalibrated"):
            followed = set(self.trace["runs"][run]["placedBy"]) - {None}
            self.assertLessEqual({"corner-left", "corner-right", "centre", "lock-left",
                                  "lock-right", "left", "right"}, followed, run)
            self.assertGreaterEqual(len(followed & {"los", "tri", "avg"}), 2, run)

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

    def test_with_the_kalman_off_the_median_goes_straight_on(self):
        ch = ChannelFilter(FilterConfig(kalman=False, fft_window=0))
        window = []
        for t, v in enumerate([70, 74, 69, 72, 75, 71, 73, 70, 76, 72]):
            window = (window + [v])[-self.cfg.median_window:]
            self.assertEqual(ch.update(v, t * 20), sorted(window)[len(window) // 2])

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
        self.assertEqual(area.max_cm, 205)

    def test_calibrated_limits_never_less_cautious_than_the_floor(self):
        area = PlayArea.calibrated([(12, 140), (12, 140), (12, 140)])
        self.assertEqual(area.alert_threshold_cm, 10, "near - 15 would be -3")

    def test_shallow_column_falls_back_to_defaults(self):
        area = PlayArea.calibrated([(20, 30), (20, 140), (20, 140)])
        self.assertFalse(area.is_calibrated)

    def test_row_hysteresis_holds_near_a_boundary(self):
        area = PlayArea.default()                      # rows split at 60 and 110
        self.assertEqual(area.row_for(0, 112, previous_row=1), 1, "within 6 cm")
        self.assertEqual(area.row_for(0, 120, previous_row=1), 2, "clear of it")


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

    # Squares on the default board (columns 50 cm wide, rows 50 cm deep from
    # 10 cm out): A is the near-left cell, B the middle, C the far-right.
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
        # In the left column near its boundary with the centre, seen by both
        # nodes: none of Dynamic's rules applies (the servo lines cross in
        # the left column but not tuning's 20 cm inside it, both nodes are
        # confident, and it is not a far corner), so it follows the steadiest
        # method.
        pipe = CoordinatePipeline(TwoSensorGeometry(method="dyn"))
        geometry = pipe.geometry
        for step in range(40):
            got = pipe.update(scanner_sample(38.0 + (step % 3), 90.0), step * 50.0)
            fixes = geometry.fixes(got.filtered, pipe.area)
            follows = geometry.placed_by(got.filtered, pipe.area)
            self.assertIn(follows, ("los", "tri", "avg"), step)
            self.assertEqual(fixes["dyn"], fixes[follows], step)
            if got.status == STATUS_OK and not got.held:
                self.assertAlmostEqual(got.x_cm, min(max(fixes[follows][0], 0.0), 150.0), msg=step)

    def test_another_method_is_placed_by_itself(self):
        geometry = TwoSensorGeometry(method="tri")
        self.assertEqual(geometry.placed_by([None] * 3, PlayArea.default()), "tri")


class DynamicRules(unittest.TestCase):
    """Dynamic's two rules, before the steadiest method (Aaron, 5 Oct): the
    centre, when both nodes' servo lines cross inside the centre column, and
    then a lone confident node."""

    FURNITURE = (150.0, 60, 1)   # the right node half-finding something in the right column

    def setUp(self):
        self.area = PlayArea.default()
        self.config = FilterConfig()

    def scan(self, geometry, sample, now_ms, fresh=(True, True, True)):
        readings = geometry.channels(sample)
        geometry.track(readings, list(fresh), now_ms, self.area, self.config)
        fix = geometry.locate(readings, self.area, self.config)
        return fix, geometry.placed_by(readings, self.area)

    def test_servo_lines_crossing_in_the_centre_put_the_player_in_the_centre(self):
        # The angles the rig read with a player 80 cm out in the centre on
        # 4 Oct (141 and 49): the lines cross at 84 cm across. The left
        # node's own reading along its line would put them at 98 cm.
        geometry = TwoSensorGeometry()
        sample = [(80.0, 141, 0), None, (80.0, 49, 0)]
        for k in range(3):
            fix, by = self.scan(geometry, sample, 50.0 * k)
        self.assertEqual(by, "centre")
        self.assertEqual(fix.column, 1)
        self.assertAlmostEqual(fix.x_cm, 25.0 + 100.0 * math.tan(math.radians(51))
                               / (math.tan(math.radians(51)) + math.tan(math.radians(41))))

    def test_left_above_90_and_right_below_90_is_not_enough(self):
        # Straight in front of the left node, its servo leant 10 degrees in
        # (100): Aaron's first form (LEFT > 90 and RIGHT < 90) would call this
        # the centre. The lines cross in the left column, so neither rule
        # applies (both nodes are confident) and the steadiest method places
        # the player.
        geometry = TwoSensorGeometry()
        left = scanner_sample(25.0, 80.0)[0]
        right = scanner_sample(25.0, 80.0)[2]
        for k in range(5):
            fix, by = self.scan(geometry, [(left[0], 100, 0), None, right], 50.0 * k)
        self.assertIn(by, ("los", "tri", "avg"))
        self.assertEqual(fix.column, 0)

    def test_the_centre_x_clears_the_column_hysteresis(self):
        # Coming from the left column, a crossing 2 cm past the boundary would
        # be held in the left column by the 8 cm margin; the rule's x is kept
        # that far inside the centre column instead.
        geometry = TwoSensorGeometry()
        for k in range(5):
            self.scan(geometry, scanner_sample(30.0, 80.0), 50.0 * k)
        fix, by = self.scan(geometry, scanner_sample(52.0, 80.0), 250.0)
        self.assertEqual(by, "centre")
        self.assertEqual((fix.x_cm, fix.column), (50.0 + self.config.column_margin_cm, 1))

    # The lone-node tests stand the player 40 cm across: the left node's line
    # and the furniture's then cross at 48 cm, short of the centre and not
    # deep in the left column, so the column lock stays out of it.
    LONE = (40.0, 85.0)

    def test_a_lone_confident_node_places_the_player_by_itself(self):
        geometry = TwoSensorGeometry()
        left = scanner_sample(*self.LONE)[0]
        for k in range(2):
            fix, by = self.scan(geometry, [left, None, self.FURNITURE], 50.0 * k)
        self.assertEqual(by, "left")
        self.assertAlmostEqual(fix.x_cm, 40.0)
        self.assertAlmostEqual(fix.y_cm, 85.0)
        self.assertEqual(fix.column, 0)

    def test_one_reading_that_found_the_player_is_not_confident(self):
        geometry = TwoSensorGeometry()
        left = scanner_sample(*self.LONE)[0]
        self.scan(geometry, [(left[0], left[1], 1), None, self.FURNITURE], 0.0)
        _, by = self.scan(geometry, [left, None, self.FURNITURE], 50.0)
        self.assertNotEqual(by, "left")
        _, by = self.scan(geometry, [left, None, self.FURNITURE], 100.0)
        self.assertEqual(by, "left")

    def test_confidence_lasts_through_the_other_nodes_turn_then_lapses(self):
        geometry = TwoSensorGeometry()
        left = scanner_sample(*self.LONE)[0]
        for k in range(2):
            self.scan(geometry, [left, None, self.FURNITURE], 50.0 * k)
        # Only the right node reports now; the left node's last reading is
        # repeated but not new.
        right_turn = (False, True, True)
        _, by = self.scan(geometry, [left, None, self.FURNITURE], 50.0 + self.config.confident_ms,
                          fresh=right_turn)
        self.assertEqual(by, "left")
        _, by = self.scan(geometry, [left, None, self.FURNITURE], 51.0 + self.config.confident_ms,
                          fresh=right_turn)
        self.assertNotEqual(by, "left")

    def test_both_nodes_confident_follow_the_steadiest_method(self):
        # In the right column, short of the side lock's 20 cm.
        geometry = TwoSensorGeometry()
        for k in range(5):
            _, by = self.scan(geometry, scanner_sample(110.0, 90.0), 50.0 * k)
        self.assertIn(by, ("los", "tri", "avg"))

    def test_the_centre_rule_comes_before_a_lone_confident_node(self):
        # The left node found the player (confident), the right one only
        # half-found them; their lines cross in the centre.
        geometry = TwoSensorGeometry()
        sample = scanner_sample(75.0, 80.0)
        sample[2] = (sample[2][0], sample[2][1], 1)
        for k in range(3):
            _, by = self.scan(geometry, sample, 50.0 * k)
        self.assertEqual(by, "centre")

    def test_the_centre_rule_needs_both_lines_to_be_recent(self):
        geometry = TwoSensorGeometry()
        centre = scanner_sample(75.0, 80.0)
        self.scan(geometry, centre, 0.0)
        # The left node sweeps from then on; the right one still finds the
        # player, but the left node's line is too old once centre_seen_ms is up.
        sample = [(None, 150, 2), None, centre[2]]
        _, by = self.scan(geometry, sample, self.config.centre_seen_ms)
        self.assertEqual(by, "centre")
        _, by = self.scan(geometry, sample, self.config.centre_seen_ms + 1.0)
        self.assertEqual(by, "right")

    def test_the_other_methods_do_not_use_the_rules(self):
        for method in ("los", "tri", "avg"):
            geometry = TwoSensorGeometry(method=method)
            for k in range(3):
                _, by = self.scan(geometry, [(80.0, 141, 0), None, (80.0, 49, 0)], 50.0 * k)
            self.assertEqual(by, method)

    # --- the centre hold and the play area (Aaron, 5 Oct) -----------------

    def test_the_centre_holds_while_the_crossing_strays_just_outside_it(self):
        # Standing still in the centre must never touch a side column. On the
        # rig on 5 Oct the crossing strayed to 103.5 cm for two readings.
        geometry = TwoSensorGeometry()
        for k in range(3):
            self.scan(geometry, scanner_sample(75.0, 80.0), 50.0 * k)
        # Here the lines stray to cross at 110 cm, past the 8 cm the column
        # hysteresis would hold anyway.
        hold = self.config.centre_hold_ms
        for t in (150.0, 100.0 + hold):
            fix, by = self.scan(geometry, scanner_sample(110.0, 80.0), t)
            self.assertEqual((by, fix.column), ("centre", 1), t)
        fix, by = self.scan(geometry, scanner_sample(110.0, 80.0), 101.0 + hold)
        self.assertIn(by, ("los", "tri", "avg"))
        self.assertEqual(fix.column, 2)

    def test_the_centre_hold_needs_both_nodes_still_seeing_the_player(self):
        self.config = FilterConfig(centre_hold_ms=5000.0)
        geometry = TwoSensorGeometry()
        self.scan(geometry, scanner_sample(75.0, 80.0), 0.0)
        # The left node sweeps from then on; its last line is too old once
        # centre_seen_ms is up, however long the hold.
        right = scanner_sample(104.0, 80.0)[2]
        _, by = self.scan(geometry, [(None, 150, 2), None, right], self.config.centre_seen_ms)
        self.assertEqual(by, "centre")
        _, by = self.scan(geometry, [(None, 150, 2), None, right], self.config.centre_seen_ms + 1.0)
        self.assertNotEqual(by, "centre")

    def test_a_lone_node_reading_in_front_of_the_near_edge_is_not_confident(self):
        # The left node, turned fully in (160), finds something 10 cm away -
        # its own point (the middle, 25 cm along its line) 8.6 cm out, in
        # front of the board's near edge (10 cm). Not the player, so it does
        # not place them on its own. (On 5 Oct it found something 27 cm away:
        # its point is 14 cm out, on the board since the rows start at 10 cm,
        # and the reading is in the dead zone, 9.2 cm out.)
        geometry = TwoSensorGeometry()
        for k in range(3):
            _, by = self.scan(geometry, [(10.0, 160, 0), None, self.FURNITURE], 50.0 * k)
        self.assertNotEqual(by, "left")

    def test_a_lone_node_reading_off_the_side_of_the_board_is_not_confident(self):
        # 5 Oct: the left node turned out to 59 found something 112 cm away,
        # 40 cm off the left edge of the board.
        geometry = TwoSensorGeometry()
        for k in range(3):
            _, by = self.scan(geometry, [(112.0, 59, 0), None, self.FURNITURE], 50.0 * k)
        self.assertNotEqual(by, "left")

    # --- the side lock, the far corners and the switches (Aaron, 5 Oct) ---

    def test_servo_lines_crossing_deep_in_a_side_column_lock_it(self):
        for x, by_want, column in ((15.0, "lock-left", 0), (135.0, "lock-right", 2)):
            geometry = TwoSensorGeometry()
            for k in range(3):
                fix, by = self.scan(geometry, scanner_sample(x, 80.0), 50.0 * k)
            self.assertEqual((by, fix.column), (by_want, column), x)
            self.assertAlmostEqual(fix.x_cm, x)

    def test_a_crossing_short_of_the_side_lock_depth_does_not_lock(self):
        # 30 cm across is exactly 20 cm inside the left column: locked. 31 cm
        # is not.
        geometry = TwoSensorGeometry()
        _, by = self.scan(geometry, scanner_sample(30.0, 80.0), 0.0)
        self.assertEqual(by, "lock-left")
        geometry = TwoSensorGeometry()
        _, by = self.scan(geometry, scanner_sample(31.0, 80.0), 0.0)
        self.assertNotEqual(by, "lock-left")

    def test_a_deep_side_crossing_ends_the_centre_hold(self):
        geometry = TwoSensorGeometry()
        for k in range(3):
            self.scan(geometry, scanner_sample(75.0, 80.0), 50.0 * k)
        _, by = self.scan(geometry, scanner_sample(15.0, 80.0), 150.0)
        self.assertEqual(by, "lock-left")
        # Back to near the boundary, well within the hold: the hold has ended,
        # so it is not the centre again.
        _, by = self.scan(geometry, scanner_sample(40.0, 80.0), 200.0)
        self.assertNotEqual(by, "centre")

    def test_the_near_node_alone_places_the_player_in_its_far_corner(self):
        # A1 for the left node, A3 for the right, while the other node is
        # acting up: it finds something in the centre near the screen.
        for slot, spot, by_want, column in ((0, (25.0, 125.0), "corner-left", 0),
                                            (2, (125.0, 125.0), "corner-right", 2)):
            geometry = TwoSensorGeometry()
            near = scanner_sample(*spot)[slot]
            other = scanner_sample(75.0, 50.0)[2 - slot]
            sample = [near, None, other] if slot == 0 else [other, None, near]
            for k in range(3):
                fix, by = self.scan(geometry, sample, 50.0 * k)
            self.assertEqual((by, fix.column), (by_want, column), by_want)
            self.assertAlmostEqual(fix.x_cm, spot[0])
            self.assertAlmostEqual(fix.y_cm, spot[1])

    def test_the_corner_needs_the_far_row(self):
        # The left node finds the player in the left column's middle row: not
        # A1, so the corner rule stays out of it.
        geometry = TwoSensorGeometry()
        sample = [scanner_sample(25.0, 80.0)[0], None, scanner_sample(75.0, 50.0)[2]]
        for k in range(3):
            _, by = self.scan(geometry, sample, 50.0 * k)
        self.assertNotEqual(by, "corner-left")

    def test_each_rule_has_a_switch(self):
        corner = [scanner_sample(25.0, 125.0)[0], None, scanner_sample(75.0, 50.0)[2]]
        lone = [scanner_sample(*self.LONE)[0], None, self.FURNITURE]
        cases = (("corner_node", corner, "corner-left"),
                 ("column_lock", scanner_sample(75.0, 80.0), "centre"),
                 ("column_lock", scanner_sample(15.0, 80.0), "lock-left"),
                 ("lone_node", lone, "left"))
        for switch, sample, by_on in cases:
            for on in (True, False):
                self.config = FilterConfig(**{switch: on})
                geometry = TwoSensorGeometry()
                for k in range(3):
                    _, by = self.scan(geometry, sample, 50.0 * k)
                if on:
                    self.assertEqual(by, by_on, switch)
                else:
                    self.assertNotEqual(by, by_on, switch)


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

    def test_beyond_the_far_limit_is_kept_on_the_far_square(self):
        # Only nobody found is out of bounds (Aaron, 5 Oct). 185 cm straight
        # out from the right node is past the far edge (160 cm): the player is
        # kept a tenth of a row inside it, 155 cm, on the far right square.
        fix = self.locate([None, None, 170.0])
        self.assertEqual(fix.status, STATUS_OK)
        self.assertEqual(fix.column, 2)
        self.assertAlmostEqual(fix.y_cm, 160.0 - 50.0 * 0.1)
        self.assertEqual(fix.distance_cm, fix.y_cm)

    def test_in_front_of_the_near_edge_is_kept_on_the_near_square(self):
        fix = self.locate(two_sensor_sample(75.0, 5.0))
        self.assertEqual(fix.status, STATUS_OK)
        self.assertAlmostEqual(fix.y_cm, 10.0 + 50.0 * 0.1)

    def test_off_either_side_of_the_board_is_kept_on_the_edge_square(self):
        # Every method, each on its own geometry (a line-of-sight track would
        # carry over). 80 cm (95 to the player's middle) from the left scanner
        # at 50 degrees: x = 25 - 95 sin 40 = -36, kept a tenth of a column
        # (5 cm) inside the left edge. With the angle limit off: on, line of
        # sight drops both readings (the next test).
        self.config = FilterConfig(angle_limit=False)
        for method in ("los", "tri", "avg"):
            left = self.scan([(80.0, 50), None, None], geometry=TwoSensorGeometry(method=method))
            self.assertEqual(left.status, STATUS_OK, method)
            self.assertEqual((left.x_cm, left.column), (5.0, 0), method)
            # From the right scanner at 130 degrees: x = 125 + 95 sin 40 = 186.
            right = self.scan([None, None, (80.0, 130)], geometry=TwoSensorGeometry(method=method))
            self.assertEqual(right.status, STATUS_OK, method)
            self.assertEqual((right.x_cm, right.column), (145.0, 2), method)

    def test_the_angle_limit_drops_those_readings_for_line_of_sight_only(self):
        # 80 cm from the left node at 50 degrees, where its line leaves the
        # grid after 38.9 cm: past the limit. Line of sight has nothing;
        # trilateration ignores the limit, and the average follows it.
        fix = self.scan([(80.0, 50), None, None], geometry=TwoSensorGeometry(method="los"))
        self.assertEqual(fix.status, STATUS_NO_SIGNAL)
        for method in ("tri", "avg"):
            fix = self.scan([(80.0, 50), None, None], geometry=TwoSensorGeometry(method=method))
            self.assertEqual((fix.status, fix.x_cm, fix.column), (STATUS_OK, 5.0, 0), method)

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
        # aim instead. Its point is 5 cm past the left edge: inside the margin,
        # so still on the board.
        d_left = math.hypot(60 - 25, 80) - BODY_RADIUS_CM
        sample = [(d_left, 70, 0), None, (math.hypot(60 - 125, 80) - BODY_RADIUS_CM, 70, 0)]
        fix = self.scan(sample, geometry=geometry)
        x, y = scanner_point(25.0, body_centre_cm(d_left, self.config), 70)
        self.assertAlmostEqual(fix.x_cm, max(5.0, x))   # off the left edge: kept on it
        self.assertAlmostEqual(fix.y_cm, y)

    def test_trilateration_prefers_a_node_whose_beam_reaches_the_board(self):
        geometry = TwoSensorGeometry(method="tri")
        # As above with both servos at 50: even the edge of the left node's
        # beam (42.5) is 22 cm past the left edge, past the margin, so nothing
        # it hears is on the board, and the right node, further away but
        # pointing on to the board, places the player - in the centre column,
        # where they are.
        d_right = math.hypot(60 - 125, 80) - BODY_RADIUS_CM
        sample = [(math.hypot(60 - 25, 80) - BODY_RADIUS_CM, 50, 0), None, (d_right, 50, 0)]
        fix = self.scan(sample, geometry=geometry)
        x, y = scanner_point(125.0, body_centre_cm(d_right, self.config), 50)
        self.assertAlmostEqual(fix.x_cm, x)
        self.assertAlmostEqual(fix.y_cm, y)
        self.assertEqual(fix.column, 1)

    def test_a_node_is_in_play_when_the_edge_of_its_beam_is_on_the_board(self):
        geometry = TwoSensorGeometry(method="tri")
        # Both servos at 60: the left node's own point is 19 cm past the left
        # edge, but its beam reaches to 67.5, and there the echo is 8 cm past
        # it, inside the margin. So the left node is in play, and being the
        # nearer, it places the player along its own aim (kept on the board).
        d_left = math.hypot(60 - 25, 80) - BODY_RADIUS_CM
        centre_x, _ = scanner_point(25.0, body_centre_cm(d_left, self.config), 60)
        edge_x, _ = scanner_point(25.0, body_centre_cm(d_left, self.config), 67.5)
        self.assertLess(centre_x, -PlayArea.EDGE_MARGIN_CM)
        self.assertGreater(edge_x, -PlayArea.EDGE_MARGIN_CM)
        sample = [(d_left, 60, 0), None, (math.hypot(60 - 125, 80) - BODY_RADIUS_CM, 60, 0)]
        fix = self.scan(sample, geometry=geometry)
        self.assertAlmostEqual(fix.x_cm, 5.0)   # off the left edge: kept on it

    def test_trilateration_crosses_the_distances_in_a_far_square_across_the_board(self):
        geometry = TwoSensorGeometry(method="tri")
        # The player's middle 150 cm out in the right column: 180 cm from the
        # left node, past the far edge plus its margin (160 + 15) as a depth,
        # but the point along the left servo's line is on the board. Both
        # distances count, and the crossing places the player.
        d_left = math.hypot(125 - 25, 150)
        self.assertGreater(d_left, PlayArea.default().far_cm + PlayArea.EDGE_MARGIN_CM)
        fix = self.scan(scanner_sample(125.0, 150.0, aim_error_deg=5.0), geometry=geometry)
        self.assertAlmostEqual(fix.x_cm, 125.0)
        self.assertAlmostEqual(fix.y_cm, 150.0)

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
        # The line-of-sight track itself, not Dynamic (whose centre rule
        # takes over in the centre column).
        geometry = TwoSensorGeometry(method="los")
        for k in range(40):
            fix = self.scan(sample, now_ms=50.0 * k, geometry=geometry)
        self.assertLess(math.dist((fix.x_cm, fix.y_cm), truth), 1.0)

    def test_readings_far_from_the_track_are_left_out_then_taken(self):
        # The line-of-sight track itself, not Dynamic (the right node's last
        # aim and the left node's new one cross in the centre column).
        geometry = TwoSensorGeometry(method="los")
        for k in range(10):
            self.scan(scanner_sample(40.0, 70.0), now_ms=50.0 * k, geometry=geometry)
        # One node's readings only, so each update is one outlier.
        relock = self.config.los_relock_readings
        for k in range(relock):
            fix = self.scan(scanner_sample(120.0, 60.0), now_ms=500.0 + 50.0 * k,
                            fresh=(True, True, False), geometry=geometry)
            if k < relock - 1:
                self.assertLess(fix.x_cm, 60.0, f"outlier {k + 1} of {relock} moved the track")
        self.assertAlmostEqual(fix.x_cm, 120.0, delta=1.0)

    def test_with_the_kalman_off_line_of_sight_takes_each_reading_at_once(self):
        # No gate and no memory: the reading the gate above turns away five
        # times is where the player is at once.
        self.config = FilterConfig(kalman=False)
        geometry = TwoSensorGeometry(method="los")
        for k in range(10):
            self.scan(scanner_sample(40.0, 70.0), now_ms=50.0 * k, geometry=geometry)
        fix = self.scan(scanner_sample(120.0, 60.0), now_ms=500.0,
                        fresh=(True, True, False), geometry=geometry)
        self.assertAlmostEqual(fix.x_cm, 120.0, delta=1.0)

    def test_the_track_is_dropped_when_nothing_usable_arrives(self):
        # The track's own timeout, so not the both-lost rule (out of bounds),
        # which would otherwise end it at the same moment.
        self.config = FilterConfig(lost_readings=LOST_READINGS_MAX)
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
        # counted on their own, so the track moves within a few updates. The
        # line-of-sight track itself, not Dynamic (whose centre rule holds the
        # centre for a moment after the lines leave it).
        geometry = TwoSensorGeometry(method="los")
        for k in range(20):
            self.scan(scanner_sample(80.0, 95.0), now_ms=50.0 * k, geometry=geometry)
        for k in range(self.config.los_relock_readings + 2):
            fix = self.scan(scanner_sample(120.0, 60.0), now_ms=1000.0 + 50.0 * k, geometry=geometry)
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


class BothNodesLost(unittest.TestCase):
    """Out of bounds, the only one there is: both nodes are lost. A node is
    lost when its last lost_readings readings, scored found +1, half 0,
    lost -1, add up to 0 or less, and not before it has had that many. No
    hold."""

    STEP_MS = 50.0
    FOUND, HALF, LOST = 0, 1, 2

    def node(self, state, slot):
        """One node's reading in that scan state: the player at (75, 80) when
        found, a stray echo when half, no echo when lost."""
        if state == self.FOUND:
            return scanner_sample(75.0, 80.0)[slot]
        return (120.0 if state == self.HALF else None, 60 if slot == 0 else 120, state)

    def both(self, state):
        return [self.node(state, 0), None, self.node(state, 2)]

    def feed(self, pipe, states, start=0, heard=None):
        """One update per state, both nodes reading it; the results."""
        return [pipe.update(self.both(state), (start + k) * self.STEP_MS, heard=heard)
                for k, state in enumerate(states)]

    def test_the_scores(self):
        self.assertEqual([lost_score(s) for s in (self.FOUND, self.HALF, self.LOST)], [1, 0, -1])

    def test_lost_once_the_last_readings_add_up_to_0_or_less(self):
        for method in ("dyn", "los", "tri", "avg"):
            pipe = CoordinatePipeline(TwoSensorGeometry(method=method))
            n = pipe.config.lost_readings
            self.assertEqual(self.feed(pipe, [self.FOUND] * n)[-1].status, STATUS_OK, method)
            # k lost after n found: the last n add up to n - 2k, 0 at k = n/2.
            results = self.feed(pipe, [self.LOST] * n, start=n)
            self.assertNotEqual(results[n // 2 - 2].status, STATUS_OUT_OF_BOUNDS, method)
            self.assertEqual(results[n // 2 - 1].status, STATUS_OUT_OF_BOUNDS, method)
            self.assertFalse(results[n // 2 - 1].held, method)

    def test_the_odd_found_or_half_does_not_stop_it(self):
        pipe = CoordinatePipeline(TwoSensorGeometry())
        pattern = [self.LOST, self.LOST, self.FOUND, self.LOST, self.HALF, self.LOST, self.LOST, self.LOST]
        results = self.feed(pipe, pattern * 5)
        self.assertTrue(all(r.status == STATUS_OUT_OF_BOUNDS for r in results[len(pattern):]))

    def test_all_half_is_lost(self):
        # On average half: 0, which is lost or half.
        pipe = CoordinatePipeline(TwoSensorGeometry())
        n = pipe.config.lost_readings
        self.assertEqual(self.feed(pipe, [self.HALF] * n)[-1].status, STATUS_OUT_OF_BOUNDS)

    def test_mostly_finding_the_player_is_never_out_of_bounds(self):
        # Three found to one lost, and found off the board too, where the
        # player is kept on the edge square.
        for where in ((75.0, 80.0), (175.0, 80.0), (75.0, 230.0)):
            pipe = CoordinatePipeline(TwoSensorGeometry())
            for k in range(200):
                sample = scanner_sample(*where) if k % 4 else self.both(self.LOST)
                result = pipe.update(sample, k * self.STEP_MS)
                self.assertNotEqual(result.status, STATUS_OUT_OF_BOUNDS, (where, k))

    def test_one_node_still_finding_the_player_is_not_out_of_bounds(self):
        pipe = CoordinatePipeline(TwoSensorGeometry())
        sample = scanner_sample(100.0, 70.0)
        sample[0] = self.node(self.LOST, 0)
        result = None
        for k in range(100):
            result = pipe.update(sample, k * self.STEP_MS)
        self.assertEqual(result.status, STATUS_OK)
        self.assertFalse(result.held)

    def test_not_before_a_node_has_had_that_many_readings(self):
        pipe = CoordinatePipeline(TwoSensorGeometry())
        n = pipe.config.lost_readings
        results = self.feed(pipe, [self.LOST] * n)
        self.assertNotEqual(results[n - 2].status, STATUS_OUT_OF_BOUNDS)
        self.assertEqual(results[n - 1].status, STATUS_OUT_OF_BOUNDS)

    def test_back_once_the_found_readings_outweigh_the_rest(self):
        pipe = CoordinatePipeline(TwoSensorGeometry())
        n = pipe.config.lost_readings
        self.feed(pipe, [self.LOST] * n)
        results = self.feed(pipe, [self.FOUND] * n, start=n)
        # n/2 found and n/2 lost add up to 0: still lost. One more, back.
        self.assertEqual(results[n // 2 - 1].status, STATUS_OUT_OF_BOUNDS)
        self.assertEqual(results[n // 2].status, STATUS_OK)

    def test_each_reading_counts_once(self):
        # Turns: the right node finds the player, sends one lost reading, then
        # waits while the left one sweeps. Its "no echo" is fresh in every
        # update (a slot with no reading always is) but was heard once, so its
        # last readings still mostly find the player.
        pipe = CoordinatePipeline(TwoSensorGeometry())
        n = pipe.config.lost_readings
        self.feed(pipe, [self.FOUND] * n)
        result = None
        for k in range(3 * n):
            result = pipe.update(self.both(self.LOST), (n + k) * self.STEP_MS,
                                 fresh=[True, True, True], heard=[True, False, k == 0])
        self.assertNotEqual(result.status, STATUS_OUT_OF_BOUNDS)

    def test_a_node_waiting_for_its_turn_keeps_its_last_readings(self):
        # The right node was lost on its last turn; now the left one is.
        pipe = CoordinatePipeline(TwoSensorGeometry())
        n = pipe.config.lost_readings
        self.feed(pipe, [self.LOST] * n, heard=[False, False, True])
        result = None
        for k in range(n):
            result = pipe.update(self.both(self.LOST), (n + k) * self.STEP_MS,
                                 fresh=[True, True, True], heard=[True, False, False])
        self.assertEqual(result.status, STATUS_OUT_OF_BOUNDS)

    def test_the_number_of_readings_is_tunable(self):
        pipe = CoordinatePipeline(TwoSensorGeometry(), config=FilterConfig(lost_readings=3))
        self.feed(pipe, [self.FOUND] * 3)
        results = self.feed(pipe, [self.LOST, self.LOST], start=3)
        # found, lost, lost: -1.
        self.assertNotEqual(results[0].status, STATUS_OUT_OF_BOUNDS)
        self.assertEqual(results[1].status, STATUS_OUT_OF_BOUNDS)
        for bad in (0, LOST_READINGS_MAX + 1):
            with self.assertRaises(ValueError):
                FilterConfig(lost_readings=bad)

    def test_nodes_without_a_scan_state_never_count_as_lost(self):
        pipe = CoordinatePipeline(TwoSensorGeometry())
        result = None
        for k in range(50):
            result = pipe.update([(None, 60), None, (None, 120)], k * self.STEP_MS)
        self.assertNotEqual(result.status, STATUS_OUT_OF_BOUNDS)

    def test_short_of_out_of_bounds_the_player_stays_on_the_board(self):
        # Off the side, past the far edge, in front of the near one, and a
        # long run of no echo from nodes that send no scan state: the player
        # stays on the board (the edge square, or the last one, held). In
        # front of the near edge is the dead zone, too close with it on
        # (DeadZone), so it is off here.
        pipe = CoordinatePipeline(TwoSensorGeometry(), config=FilterConfig(dead_zone=False))
        t = 0.0
        for where, cell in (((-30.0, 80.0), (0, 1)), ((75.0, 220.0), (1, 2)),
                            ((180.0, 40.0), (2, 0)), ((75.0, 5.0), (1, 0))):
            pipe.reset()
            result = None
            for k in range(60):
                result = pipe.update(scanner_sample(*where), t + k * self.STEP_MS)
            self.assertEqual(result.status, STATUS_OK, where)
            self.assertEqual((result.gx, result.gy), cell, where)
            t += 4000.0
        held = None
        for k in range(400):
            held = pipe.update([None, None, None], t + k * self.STEP_MS)
        self.assertEqual(held.status, STATUS_OK)
        self.assertTrue(held.held)
        self.assertGreater(held.held_for, 300)


class CartesianGeometryBehaviour(unittest.TestCase):
    """The entry point for a rig that reports (x, y) itself."""

    def setUp(self):
        self.pipe = CoordinatePipeline(CartesianGeometry())

    def test_passes_a_position_through(self):
        result = self.pipe.update((120.0, 90.0), 0)
        self.assertEqual(result.status, STATUS_OK)
        self.assertEqual((result.x_cm, result.y_cm), (120.0, 90.0))
        self.assertEqual((result.gx, result.gy), (2, 1))

    def test_x_off_the_board_is_not_out_of_bounds(self):
        # Only nobody found is out of bounds: a position off the board is an
        # unusable reading, ridden out like any other (here nothing is held).
        self.pipe = CoordinatePipeline(CartesianGeometry(),
                                       config=FilterConfig(hold_readings=0))
        self.assertEqual(self.pipe.update((-40.0, 80.0), 0).status, STATUS_NO_SIGNAL)

    def test_depth_drives_the_proximity_alert(self):
        self.pipe = CoordinatePipeline(CartesianGeometry(),
                                       config=FilterConfig(too_close_frames=1))
        self.assertEqual(self.pipe.update((75.0, 4.0), 0).status, STATUS_TOO_CLOSE)

    def test_missing_position_is_no_signal(self):
        self.pipe = CoordinatePipeline(CartesianGeometry(),
                                       config=FilterConfig(hold_readings=0))
        self.assertEqual(self.pipe.update(None, 0).status, STATUS_NO_SIGNAL)


class AngleLimit(unittest.TestCase):
    """The angle limit (Aaron, 5 Oct): on the 150 x 160 cm grid, a node's
    filtered distance further than its servo line runs on the grid (+5 cm)
    is not a player; line of sight and Dynamic's node rules drop it, and
    trilateration ignores it."""

    def test_the_limit_is_where_the_servo_line_leaves_the_grid(self):
        self.assertEqual(GRID_LENGTH_CM, 160.0)
        self.assertEqual(angle_limit_cm(25.0, 90), 160.0)
        self.assertEqual(angle_limit_cm(25.0, None), 160.0)
        self.assertAlmostEqual(angle_limit_cm(25.0, 70), 73.1, places=1)    # left wall
        self.assertAlmostEqual(angle_limit_cm(25.0, 40), 32.6, places=1)    # its servo's limit
        self.assertAlmostEqual(angle_limit_cm(25.0, 120), 184.8, places=1)  # far edge
        self.assertAlmostEqual(angle_limit_cm(25.0, 150), 144.3, places=1)  # right wall
        corner = 90 + math.degrees(math.atan2(125.0, 160.0))                 # the far right corner
        self.assertAlmostEqual(angle_limit_cm(25.0, corner), math.hypot(125.0, 160.0), places=6)
        # The right node is the left one mirrored.
        for angle in (30, 52, 75, 90, 99, 110, 140):
            self.assertAlmostEqual(angle_limit_cm(125.0, angle), angle_limit_cm(25.0, 180 - angle),
                                   places=9)

    def test_a_reading_up_to_five_cm_past_it_still_counts(self):
        area, config = PlayArea.default(), FilterConfig()
        limit = angle_limit_cm(25.0, 70)
        self.assertTrue(within_angle_limit(25.0, limit + 4.99, 70, area, config))
        self.assertFalse(within_angle_limit(25.0, limit + 5.01, 70, area, config))
        self.assertTrue(within_angle_limit(25.0, 400.0, 70, area, FilterConfig(angle_limit=False)))

    def test_a_servo_line_past_the_limit_does_not_lock_the_centre(self):
        # The 4 Oct centre-test angles (141 and 49) cross in the centre column.
        # A left reading of 170 cm at 141 degrees is past its line's 160.8 cm
        # (+5), so the left aim does not count and nothing locks the centre.
        def placed(config):
            geometry = TwoSensorGeometry()
            area = PlayArea.default()
            for k in range(3):
                readings = geometry.channels([(170.0, 141, 0), None, (80.0, 49, 0)])
                geometry.track(readings, [True] * 3, 100.0 * k, area, config)
            return geometry.placed_by(readings, area)

        self.assertEqual(placed(FilterConfig(angle_limit=False)), "centre")
        self.assertNotEqual(placed(FilterConfig()), "centre")

    def test_the_pipeline_switch_changes_only_the_angle_limit(self):
        pipeline = CoordinatePipeline(TwoSensorGeometry(method="los"))
        pipeline.set_angle_limit(False)
        self.assertFalse(pipeline.config.angle_limit)
        self.assertEqual(pipeline.config, FilterConfig(angle_limit=False))
        pipeline.set_angle_limit(True)
        self.assertTrue(pipeline.config.angle_limit)

    def test_the_parity_runs_show_the_switch_doing_something(self):
        with open(FIXTURE, encoding="utf-8") as fh:
            trace = json.load(fh)
        runs = trace["runs"]
        at = trace["fields"].index("x")
        changed = sum(1 for a, b in zip(runs["default"]["steps"], runs["angleLimitOff"]["steps"])
                      if a[at] != b[at])
        self.assertGreater(changed, 20, "line of sight should differ with the angle limit off")


class DeadZone(unittest.TestCase):
    """The dead zone (Aaron, 5 Oct): too close when a raw reading's point along
    its node's servo line is less than 10 cm out, the strip across the front
    of the grid; with the switch off, when the raw reading itself is."""

    STEP_MS = 50.0

    def settle(self, sample, config=None):
        """Two updates of the same sample, enough to confirm too close."""
        pipe = CoordinatePipeline(TwoSensorGeometry(), config=config)
        result = None
        for k in range(2):
            result = pipe.update(sample, k * self.STEP_MS)
        return result

    def test_turned_in_a_reading_over_10_cm_is_too_close(self):
        # The right node at 31 degrees reads 14 cm: 14 cos 59 = 7.2 cm out.
        # The left one sees the player's back half, 60 cm out.
        sample = [(60.0, 150, 0), None, (14.0, 31, 0)]
        result = self.settle(sample)
        self.assertEqual(result.status, STATUS_TOO_CLOSE)
        self.assertAlmostEqual(result.y_cm, 14.0 * math.cos(math.radians(59)))
        self.assertNotEqual(self.settle(sample, FilterConfig(dead_zone=False)).status,
                            STATUS_TOO_CLOSE)

    def test_the_distance_into_the_dead_zone_follows_the_servo_angle(self):
        # 10 / cos(phi): 10 cm straight out, 15.6 at 40 and 140, 29.2 at 160.
        for angle, edge in ((90, 10.0), (40, 15.557), (140, 15.557), (160, 29.238)):
            inside = self.settle([(edge - 0.1, angle, 0), None, None])
            outside = self.settle([(edge + 0.1, angle, 0), None, None])
            self.assertEqual(inside.status, STATUS_TOO_CLOSE, angle)
            self.assertNotEqual(outside.status, STATUS_TOO_CLOSE, angle)

    def test_off_only_the_reading_itself_counts(self):
        off = FilterConfig(dead_zone=False)
        self.assertNotEqual(self.settle([(25.0, 160, 0), None, None], off).status, STATUS_TOO_CLOSE)
        result = self.settle([(9.0, 160, 0), None, None], off)
        self.assertEqual(result.status, STATUS_TOO_CLOSE)
        self.assertEqual(result.y_cm, 9.0)

    def test_one_close_reading_is_not_enough(self):
        pipe = CoordinatePipeline(TwoSensorGeometry())
        result = pipe.update([(20.0, 150, 0), None, None], 0.0)
        self.assertNotEqual(result.status, STATUS_TOO_CLOSE)

    def test_the_rows_start_behind_the_dead_zone(self):
        area = PlayArea.default()
        self.assertEqual(area.per_column, ((10.0, 160.0),) * 3)
        self.assertEqual([area.row_for(0, y) for y in (11, 59, 61, 109, 111, 159)],
                         [0, 0, 1, 1, 2, 2])
        self.assertEqual(area.alert_threshold_cm, 10.0)

    def test_the_pipeline_switch_changes_only_the_dead_zone(self):
        pipeline = CoordinatePipeline(TwoSensorGeometry(method="los"))
        pipeline.set_dead_zone(False)
        self.assertFalse(pipeline.config.dead_zone)
        self.assertEqual(pipeline.config, FilterConfig(dead_zone=False))
        pipeline.set_dead_zone(True)
        self.assertTrue(pipeline.config.dead_zone)

    def test_the_parity_runs_show_the_switch_doing_something(self):
        with open(FIXTURE, encoding="utf-8") as fh:
            trace = json.load(fh)
        runs = trace["runs"]
        at = trace["fields"].index("status")
        close = [sum(1 for step in runs[name]["steps"] if step[at] == STATUS_TOO_CLOSE)
                 for name in ("default", "deadZoneOff")]
        self.assertGreater(close[0], close[1] + 50, "too close more often with the dead zone on")


if __name__ == "__main__":
    unittest.main()
