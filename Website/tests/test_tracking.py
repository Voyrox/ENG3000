"""
Tests for tracking.py (constant-velocity Kalman tracker and the per-channel
PathPredictor that serverFilter.py uses for path prediction).

Standard library only:

    python -m unittest discover -s Website/tests
"""

import json
import math
import os
import statistics
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from tracking import (  # noqa: E402
    DEFAULT_GAP_RESET_S,
    DEFAULT_MAX_LEAD_S,
    DEFAULT_MAX_RANGE_CM,
    DEFAULT_NIS_GATE,
    DEFAULT_SIGMA_A_CM_S2,
    DEFAULT_SIGMA_R_CM,
    DEFAULT_V_MAX_CM_S,
    REACQ_READINGS,
    ConstantVelocityTracker,
    PathPredictor,
    alpha_beta_closed_form,
)

# Typical interval between two readings of one channel, s.
SAMPLE_DT_S = 0.079
# Walking-pace ramp used for the tracking tests, cm/s.
RAMP_SPEED_CM_S = 50.0
RAMP_START_CM = 60.0
# Window of the median the tracker is compared with (filterRules default).
MEDIAN_WINDOW = 5


def ramp_cm(t_s):
    return RAMP_START_CM + RAMP_SPEED_CM_S * t_s


def run_ramp(tracker, n):
    """Feed n noiseless ramp readings; return the last time stamp."""
    t_s = 0.0
    for k in range(n):
        t_s = k * SAMPLE_DT_S
        tracker.update(ramp_cm(t_s), t_s)
    return t_s


class ConstantInput(unittest.TestCase):
    def test_converges_to_constant(self):
        tr = ConstantVelocityTracker()
        tr.update(150.0, 0.0)
        for k in range(1, 50):
            tr.update(100.0, k * SAMPLE_DT_S)
        self.assertAlmostEqual(tr.distance_cm, 100.0, delta=0.05)
        self.assertAlmostEqual(tr.velocity_cm_s, 0.0, delta=0.5)

    def test_negative_reading_is_missing_not_zero(self):
        tr = ConstantVelocityTracker()
        for k in range(10):
            tr.update(100.0, k * SAMPLE_DT_S)
        est = tr.update(-1.0, 10 * SAMPLE_DT_S)
        self.assertAlmostEqual(est, 100.0, delta=0.5)

    def test_no_track_until_first_reading(self):
        tr = ConstantVelocityTracker()
        self.assertIsNone(tr.update(None, 0.0))
        self.assertIsNone(tr.predict(0.1))
        self.assertEqual(tr.update(80.0, 0.1), 80.0)


class Ramp(unittest.TestCase):
    def test_lag_smaller_than_median(self):
        tr = ConstantVelocityTracker()
        readings = []
        n = 40
        for k in range(n):
            t_s = k * SAMPLE_DT_S
            z = ramp_cm(t_s)
            readings.append(z)
            tr.update(z, t_s)
        truth = ramp_cm((n - 1) * SAMPLE_DT_S)
        median_lag_cm = abs(truth - statistics.median(readings[-MEDIAN_WINDOW:]))
        kalman_lag_cm = abs(truth - tr.distance_cm)
        # median of 5 lags a ramp by 2 samples
        self.assertAlmostEqual(median_lag_cm, 2 * RAMP_SPEED_CM_S * SAMPLE_DT_S, places=6)
        self.assertLess(kalman_lag_cm, median_lag_cm / 10.0)
        self.assertAlmostEqual(tr.velocity_cm_s, RAMP_SPEED_CM_S, delta=1.0)

    def test_none_predicts_forward(self):
        tr = ConstantVelocityTracker()
        t_last = run_ramp(tr, 30)
        t_miss = t_last + SAMPLE_DT_S
        est = tr.update(None, t_miss)
        self.assertAlmostEqual(est, ramp_cm(t_miss), delta=0.5)
        # and the next real reading continues the track
        t_next = t_miss + SAMPLE_DT_S
        self.assertAlmostEqual(tr.update(ramp_cm(t_next), t_next), ramp_cm(t_next), delta=0.5)

    def test_predict_ahead_extrapolates_linearly(self):
        tr = ConstantVelocityTracker()
        t_last = run_ramp(tr, 30)
        before = (tr.distance_cm, tr.velocity_cm_s, tr.t_s)
        for ahead_s in (0.0, 0.1, 0.25):
            self.assertAlmostEqual(tr.predict(ahead_s), ramp_cm(t_last + ahead_s), delta=0.5)
        # linear in ahead_s
        p0, p1, p2 = tr.predict(0.0), tr.predict(0.1), tr.predict(0.2)
        self.assertAlmostEqual(p2 - p1, p1 - p0, places=9)
        # predict does not change the state
        self.assertEqual((tr.distance_cm, tr.velocity_cm_s, tr.t_s), before)


class GapReset(unittest.TestCase):
    def test_long_gap_restarts_on_next_reading(self):
        tr = ConstantVelocityTracker(gap_reset_s=0.5)
        run_ramp(tr, 20)
        t_s = 20 * SAMPLE_DT_S + 1.0
        self.assertEqual(tr.update(200.0, t_s), 200.0)
        self.assertEqual(tr.velocity_cm_s, 0.0)

    def test_long_gap_of_missing_readings_drops_track(self):
        tr = ConstantVelocityTracker(gap_reset_s=0.5)
        t_last = run_ramp(tr, 20)
        t_s = t_last
        while t_s - t_last <= 0.5:
            t_s += SAMPLE_DT_S
            est = tr.update(None, t_s)
        self.assertIsNone(est)
        self.assertFalse(tr.alive)
        self.assertIsNone(tr.predict(0.1))

    def test_short_gap_keeps_track(self):
        tr = ConstantVelocityTracker(gap_reset_s=0.5)
        t_last = run_ramp(tr, 20)
        tr.update(None, t_last + 0.2)
        self.assertTrue(tr.alive)


class SteadyState(unittest.TestCase):
    def test_gain_matches_closed_form(self):
        tr = ConstantVelocityTracker()
        for k in range(300):
            tr.update(100.0, k * SAMPLE_DT_S)
        k0, k1 = tr.last_gain
        index = DEFAULT_SIGMA_A_CM_S2 * SAMPLE_DT_S ** 2 / DEFAULT_SIGMA_R_CM
        alpha, beta = alpha_beta_closed_form(index)
        self.assertAlmostEqual(k0, alpha, places=6)
        self.assertAlmostEqual(k1 * SAMPLE_DT_S, beta, places=6)

    def test_bad_parameters_rejected(self):
        with self.assertRaises(ValueError):
            ConstantVelocityTracker(sigma_r_cm=0.0)
        with self.assertRaises(ValueError):
            ConstantVelocityTracker(gap_reset_s=0.0)


class LeadCap(unittest.TestCase):
    def test_cap_matches_the_model(self):
        # The unit's sensing model capped display extrapolation at 250 ms.
        self.assertEqual(DEFAULT_MAX_LEAD_S, 0.25)

    def test_predict_beyond_cap_is_clamped(self):
        tr = ConstantVelocityTracker()
        run_ramp(tr, 30)
        at_cap = tr.predict(DEFAULT_MAX_LEAD_S)
        self.assertEqual(tr.predict(DEFAULT_MAX_LEAD_S * 4), at_cap)
        self.assertEqual(tr.predict(10.0), at_cap)
        self.assertGreater(at_cap, tr.predict(DEFAULT_MAX_LEAD_S / 2))

    def test_custom_cap(self):
        tr = ConstantVelocityTracker(max_lead_s=0.1)
        run_ramp(tr, 30)
        self.assertEqual(tr.predict(0.5), tr.predict(0.1))

    def test_negative_cap_rejected(self):
        with self.assertRaises(ValueError):
            ConstantVelocityTracker(max_lead_s=-0.1)

    def test_predict_at_caps_total_lead(self):
        tr = ConstantVelocityTracker()
        t_last = run_ramp(tr, 30)
        # 0.2 s since the update plus 0.2 s lead is 0.4 s: capped at 0.25 s.
        self.assertEqual(tr.predict_at(t_last + 0.2, lead_s=0.2),
                         tr.predict(DEFAULT_MAX_LEAD_S))


class PredictAtGap(unittest.TestCase):
    def test_no_prediction_after_gap(self):
        tr = ConstantVelocityTracker(gap_reset_s=0.5)
        t_last = run_ramp(tr, 20)
        self.assertIsNotNone(tr.predict_at(t_last + 0.4))
        self.assertIsNone(tr.predict_at(t_last + 0.6))

    def test_no_prediction_without_track(self):
        self.assertIsNone(ConstantVelocityTracker().predict_at(1.0))


class PathPredictorChannels(unittest.TestCase):
    def test_channels_are_independent(self):
        pp = PathPredictor(3)
        pp.update(0, 60.0, 0.0)
        pp.update(2, 120.0, 0.05)
        self.assertEqual(pp.predicted_cm(0.05), [60.0, None, 120.0])
        pp.reset_channel(0)
        self.assertEqual(pp.predicted_cm(0.05), [None, None, 120.0])
        pp.reset()
        self.assertEqual(pp.predicted_cm(0.05), [None, None, None])

    def test_tracker_settings_are_passed_through(self):
        pp = PathPredictor(2, max_lead_s=0.1, gap_reset_s=0.3)
        self.assertTrue(all(t.max_lead_s == 0.1 and t.gap_reset_s == 0.3
                            for t in pp.trackers))

    def test_needs_a_channel(self):
        with self.assertRaises(ValueError):
            PathPredictor(0)

    def test_gate_and_speed_limit_are_on_for_raw_readings(self):
        pp = PathPredictor(2)
        self.assertTrue(all(t.nis_gate == DEFAULT_NIS_GATE and t.v_max_cm_s == DEFAULT_V_MAX_CM_S
                            for t in pp.trackers))
        off = PathPredictor(1, nis_gate=None, v_max_cm_s=None)
        self.assertIsNone(off.trackers[0].nis_gate)
        self.assertIsNone(off.trackers[0].v_max_cm_s)


# A reading far from a player standing at STEADY_CM: crosstalk or a stray echo.
STEADY_CM = 100.0
SPIKE_CM = 250.0


def steady(tracker, n=30, distance_cm=STEADY_CM):
    """Feed n readings of a standing player; return the last time stamp."""
    t_s = 0.0
    for k in range(n):
        t_s = k * SAMPLE_DT_S
        tracker.update(distance_cm, t_s)
    return t_s


def state_is_finite(tracker):
    return all(math.isfinite(v) for v in (tracker.distance_cm, tracker.velocity_cm_s,
                                          tracker.p00, tracker.p01, tracker.p11))


class NonFiniteReadings(unittest.TestCase):
    """H1: a NaN once made the state, and every prediction after it, NaN;
    json.dumps then wrote a bare NaN that the browser cannot parse."""

    def test_nan_is_missing(self):
        tr = ConstantVelocityTracker()
        t_last = run_ramp(tr, 30)
        est = tr.update(math.nan, t_last + SAMPLE_DT_S)
        self.assertAlmostEqual(est, ramp_cm(t_last + SAMPLE_DT_S), delta=0.5)
        self.assertTrue(state_is_finite(tr))
        t_next = t_last + 2 * SAMPLE_DT_S
        self.assertAlmostEqual(tr.update(ramp_cm(t_next), t_next), ramp_cm(t_next), delta=0.5)

    def test_infinities_are_missing(self):
        for bad in (math.inf, -math.inf):
            for negative_is_missing in (True, False):
                tr = ConstantVelocityTracker(negative_is_missing=negative_is_missing)
                t_last = steady(tr)
                est = tr.update(bad, t_last + SAMPLE_DT_S)
                self.assertAlmostEqual(est, STEADY_CM, delta=0.5)
                self.assertTrue(state_is_finite(tr))

    def test_nan_first_reading_starts_no_track(self):
        tr = ConstantVelocityTracker(negative_is_missing=False)
        self.assertIsNone(tr.update(math.nan, 0.0))
        self.assertFalse(tr.alive)

    def test_a_non_finite_time_changes_nothing(self):
        tr = ConstantVelocityTracker()
        steady(tr)
        before = (tr.distance_cm, tr.velocity_cm_s, tr.t_s, tr.p00)
        self.assertAlmostEqual(tr.update(STEADY_CM, math.nan), STEADY_CM, delta=0.5)
        self.assertEqual((tr.distance_cm, tr.velocity_cm_s, tr.t_s, tr.p00), before)
        self.assertTrue(math.isfinite(tr.predict_at(math.nan)))

    def test_an_absurd_reading_cannot_overflow_the_state(self):
        tr = ConstantVelocityTracker(negative_is_missing=False)
        t_last = steady(tr)
        est = tr.update(1e308, t_last + SAMPLE_DT_S)
        self.assertTrue(est is None or math.isfinite(est))
        self.assertTrue(not tr.alive or state_is_finite(tr))

    def test_predictions_stay_json_safe(self):
        pp = PathPredictor(2)
        for k in range(20):
            pp.update(0, STEADY_CM, k * SAMPLE_DT_S)
            pp.update(1, 80.0, k * SAMPLE_DT_S)
        t_s = 20 * SAMPLE_DT_S
        for bad in (math.nan, math.inf, -math.inf):
            pp.update(0, bad, t_s)
            pp.update(1, bad, t_s)
            t_s += SAMPLE_DT_S
        # allow_nan=False raises on NaN or inf, as the browser's JSON.parse would.
        json.dumps(pp.predicted_cm(t_s), allow_nan=False)


class LeadCapAcrossMisses(unittest.TestCase):
    """M1: no-echo readings used to move the state forward, so predict_at
    extrapolated from there and the total lead reached ~474 ms."""

    def test_no_echo_readings_do_not_extend_the_lead(self):
        tr = ConstantVelocityTracker()
        t_last = run_ramp(tr, 30)
        at_reading_cm = tr.distance_cm
        furthest_cm = abs(tr.velocity_cm_s) * DEFAULT_MAX_LEAD_S
        t_s = t_last
        while t_s + SAMPLE_DT_S - t_last <= DEFAULT_GAP_RESET_S:
            t_s += SAMPLE_DT_S
            est = tr.update(-1.0, t_s)
            self.assertLessEqual(abs(est - at_reading_cm), furthest_cm + 1e-9)
            lead = tr.predict_at(t_s, lead_s=DEFAULT_MAX_LEAD_S)
            self.assertLessEqual(abs(lead - at_reading_cm), furthest_cm + 1e-9)
        # the loop did run past the cap, so the cap was what held it
        self.assertGreater(t_s - t_last, DEFAULT_MAX_LEAD_S)
        self.assertAlmostEqual(tr.predict_at(t_s, lead_s=DEFAULT_MAX_LEAD_S),
                               ramp_cm(t_last + DEFAULT_MAX_LEAD_S), delta=0.5)

    def test_missing_readings_leave_the_state_at_the_last_reading(self):
        tr = ConstantVelocityTracker()
        t_last = run_ramp(tr, 30)
        tr.update(None, t_last + SAMPLE_DT_S)
        tr.update(-1.0, t_last + 2 * SAMPLE_DT_S)
        self.assertEqual(tr.t_s, t_last)


class SpikeGate(unittest.TestCase):
    def test_a_single_spike_is_not_absorbed(self):
        tr = ConstantVelocityTracker(nis_gate=DEFAULT_NIS_GATE)
        t_last = steady(tr)
        est = tr.update(SPIKE_CM, t_last + SAMPLE_DT_S)
        self.assertAlmostEqual(est, STEADY_CM, delta=0.5)
        self.assertAlmostEqual(tr.velocity_cm_s, 0.0, delta=0.5)
        t_next = t_last + 2 * SAMPLE_DT_S
        self.assertAlmostEqual(tr.update(STEADY_CM, t_next), STEADY_CM, delta=0.5)

    def test_without_the_gate_the_spike_is_absorbed(self):
        # The contrast: this is what the chain's copy does, where the slew
        # gate and the median stop spikes before the tracker sees them.
        tr = ConstantVelocityTracker()
        t_last = steady(tr)
        self.assertGreater(tr.update(SPIKE_CM, t_last + SAMPLE_DT_S), STEADY_CM + 50.0)

    def test_agreeing_gated_readings_reacquire(self):
        tr = ConstantVelocityTracker(nis_gate=DEFAULT_NIS_GATE)
        t_s = steady(tr)
        moved_cm = STEADY_CM + 60.0
        for k in range(REACQ_READINGS - 1):
            t_s += SAMPLE_DT_S
            self.assertAlmostEqual(tr.update(moved_cm + k, t_s), STEADY_CM, delta=0.5)
        t_s += SAMPLE_DT_S
        last_cm = moved_cm + REACQ_READINGS - 1
        self.assertEqual(tr.update(last_cm, t_s), last_cm)
        self.assertEqual(tr.velocity_cm_s, 0.0)

    def test_scattered_spikes_do_not_reacquire(self):
        tr = ConstantVelocityTracker(nis_gate=DEFAULT_NIS_GATE)
        t_s = steady(tr)
        for spike_cm in (SPIKE_CM, 30.0, SPIKE_CM + 60.0, 30.0):
            t_s += SAMPLE_DT_S
            self.assertAlmostEqual(tr.update(spike_cm, t_s), STEADY_CM, delta=0.5)

    def test_gate_is_off_by_default(self):
        # The filtering chain's copy must match game.js's kalmanUpdate().
        self.assertIsNone(ConstantVelocityTracker().nis_gate)
        self.assertIsNone(ConstantVelocityTracker().v_max_cm_s)


class SpeedLimit(unittest.TestCase):
    FAST_CM_S = 1000.0

    def run_fast(self, tracker):
        for k in range(30):
            t_s = k * SAMPLE_DT_S
            tracker.update(RAMP_START_CM + self.FAST_CM_S * t_s, t_s)

    def test_velocity_is_clamped(self):
        tr = ConstantVelocityTracker(v_max_cm_s=DEFAULT_V_MAX_CM_S, range_cm=(0.0, 1e6))
        self.run_fast(tr)
        self.assertLessEqual(abs(tr.velocity_cm_s), DEFAULT_V_MAX_CM_S)
        self.assertEqual(tr.velocity_cm_s, DEFAULT_V_MAX_CM_S)

    def test_without_the_limit_it_is_not(self):
        tr = ConstantVelocityTracker(range_cm=(0.0, 1e6))
        self.run_fast(tr)
        self.assertGreater(tr.velocity_cm_s, DEFAULT_V_MAX_CM_S)


class RangeClamp(unittest.TestCase):
    def test_distance_channel_is_clamped_to_range(self):
        tr = ConstantVelocityTracker()
        self.assertEqual(tr.range_cm, (0.0, DEFAULT_MAX_RANGE_CM))
        self.assertEqual(tr.update(DEFAULT_MAX_RANGE_CM + 50.0, 0.0), DEFAULT_MAX_RANGE_CM)

    def test_prediction_never_goes_below_zero(self):
        tr = ConstantVelocityTracker()
        # walking into the sensor at 50 cm/s, last reading 5 cm away
        for k in range(20):
            t_s = k * SAMPLE_DT_S
            tr.update(5.0 + RAMP_SPEED_CM_S * (19 - k) * SAMPLE_DT_S, t_s)
        self.assertLess(tr.distance_cm + tr.velocity_cm_s * DEFAULT_MAX_LEAD_S, 0.0)
        self.assertEqual(tr.predict(DEFAULT_MAX_LEAD_S), 0.0)

    def test_x_coordinate_is_not_clamped(self):
        tr = ConstantVelocityTracker(negative_is_missing=False)
        self.assertIsNone(tr.range_cm)
        self.assertEqual(tr.update(-40.0, 0.0), -40.0)
        tr.reset()
        self.assertEqual(tr.update(DEFAULT_MAX_RANGE_CM + 50.0, 0.0), DEFAULT_MAX_RANGE_CM + 50.0)
        tr.reset()
        # moving left past x = 0: the prediction follows it below zero
        for k in range(20):
            t_s = k * SAMPLE_DT_S
            tr.update(5.0 - RAMP_SPEED_CM_S * t_s, t_s)
        self.assertLess(tr.predict(DEFAULT_MAX_LEAD_S), 0.0)

    def test_x_coordinate_is_clamped_when_given_a_range(self):
        tr = ConstantVelocityTracker(negative_is_missing=False, range_cm=(-20.0, 170.0))
        self.assertEqual(tr.update(-40.0, 0.0), -20.0)

    def test_bad_limits_rejected(self):
        for kwargs in ({"range_cm": (10.0, 0.0)}, {"range_cm": (0.0, math.nan)},
                       {"nis_gate": 0.0}, {"v_max_cm_s": 0.0}):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                ConstantVelocityTracker(**kwargs)


if __name__ == "__main__":
    unittest.main()
