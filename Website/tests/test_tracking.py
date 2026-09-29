"""
Tests for tracking.py (constant-velocity Kalman tracker and the per-channel
PathPredictor that serverFilter.py uses for path prediction).

Standard library only:

    python -m unittest discover -s Website/tests
"""

import os
import statistics
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from tracking import (  # noqa: E402
    DEFAULT_MAX_LEAD_S,
    DEFAULT_SIGMA_A_CM_S2,
    DEFAULT_SIGMA_R_CM,
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


if __name__ == "__main__":
    unittest.main()
