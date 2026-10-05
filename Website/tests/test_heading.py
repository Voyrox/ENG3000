"""
Tests for heading.py: the cell a moving player is walking into when a node
loses them (Aaron, 6 Oct).

Run with:

    python -m unittest discover -s Website/tests
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from filterRules import PlayArea  # noqa: E402
from heading import (LEAD_S, MAX_AHEAD_CM, TRACK_FRESH_S, Track,  # noqa: E402
                     heading_target, predicted_point, track_from_event)

NOW = 100.0
AREA = PlayArea.default()            # 150 cm across in 50 cm columns; rows 10-60, 60-110, 110-160


def moving(x, y, vx, vy, age_s=0.0, still=False):
    return Track(not still, x, y, vx, vy, NOW - age_s)


class HeadingTarget(unittest.TestCase):

    def test_walking_across_into_the_next_column(self):
        # 40 cm across at 60 cm/s to the right: 30 cm on, LEAD_S ahead, is
        # 70 cm across - the centre column, middle row.
        self.assertEqual(LEAD_S, 0.5)
        self.assertEqual(heading_target(moving(40.0, 80.0, 60.0, 0.0), NOW, AREA), (1, 1))
        # The same walk to the left stays in the left column.
        self.assertEqual(heading_target(moving(40.0, 80.0, -60.0, 0.0), NOW, AREA), (0, 1))

    def test_walking_back_into_the_back_row(self):
        self.assertEqual(heading_target(moving(75.0, 100.0, 0.0, 40.0), NOW, AREA), (1, 2))

    def test_the_track_s_age_counts_towards_the_step(self):
        # Last reading 0.5 s ago: a second on at 30 cm/s is 30 cm, 40 -> 70.
        self.assertEqual(predicted_point(moving(40.0, 80.0, 30.0, 0.0, age_s=0.5), NOW), (70.0, 80.0))
        self.assertEqual(predicted_point(moving(40.0, 80.0, 30.0, 0.0), NOW), (55.0, 80.0))

    def test_never_more_than_a_cell_ahead(self):
        # 300 cm/s for 0.5 s would be 150 cm; it stops MAX_AHEAD_CM on.
        self.assertEqual(MAX_AHEAD_CM, 50.0)
        x, y = predicted_point(moving(20.0, 80.0, 300.0, 0.0), NOW)
        self.assertAlmostEqual(x, 70.0)
        self.assertAlmostEqual(y, 80.0)
        x, y = predicted_point(moving(20.0, 80.0, 300.0, 400.0), NOW)
        self.assertAlmostEqual(x, 50.0)       # 3-4-5: 30 across, 40 out
        self.assertAlmostEqual(y, 120.0)

    def test_heading_off_the_board_is_its_edge_cell(self):
        self.assertEqual(heading_target(moving(140.0, 150.0, 80.0, 80.0), NOW, AREA), (2, 2))
        self.assertEqual(heading_target(moving(10.0, 20.0, -80.0, -80.0), NOW, AREA), (0, 0))

    def test_a_still_player_or_an_old_track_is_left_to_the_search(self):
        self.assertIsNone(heading_target(None, NOW, AREA))
        self.assertIsNone(heading_target(moving(40.0, 80.0, 60.0, 0.0, still=True), NOW, AREA))
        self.assertIsNotNone(heading_target(moving(40.0, 80.0, 60.0, 0.0, age_s=TRACK_FRESH_S), NOW, AREA))
        self.assertIsNone(heading_target(moving(40.0, 80.0, 60.0, 0.0, age_s=TRACK_FRESH_S + 0.01),
                                         NOW, AREA))

    def test_moving_with_no_speed_yet_is_where_the_track_is(self):
        self.assertEqual(heading_target(moving(130.0, 30.0, 0.0, 0.0), NOW, AREA), (2, 0))

    def test_the_calibrated_rows_set_the_row(self):
        # Rows 20-140 in the centre column: 40 cm each, so 95 cm out is the
        # middle row there, and 105 cm the back one.
        area = PlayArea.calibrated([(20.0, 140.0)] * 3)
        self.assertEqual(heading_target(moving(75.0, 90.0, 0.0, 10.0), NOW, area), (1, 1))
        self.assertEqual(heading_target(moving(75.0, 100.0, 0.0, 10.0), NOW, area), (1, 2))


class TrackFromEvent(unittest.TestCase):

    def test_a_track_update(self):
        track = track_from_event({"type": "track:update", "moving": True, "x": 40, "y": 80.5,
                                  "vx": 60, "vy": -5.5, "ageMs": 250}, NOW)
        self.assertEqual(track, Track(True, 40.0, 80.5, 60.0, -5.5, NOW - 0.25))

    def test_no_velocity_or_age_is_zero(self):
        track = track_from_event({"moving": False, "x": 40, "y": 80, "vx": None}, NOW)
        self.assertEqual(track, Track(False, 40.0, 80.0, 0.0, 0.0, NOW))
        # A negative age (clock skew) is now, not the future.
        self.assertEqual(track_from_event({"moving": True, "x": 1, "y": 2, "ageMs": -40}, NOW).at_s, NOW)

    def test_no_usable_track(self):
        for message in (None, "track", {}, {"moving": "yes", "x": 1, "y": 2},
                        {"moving": True, "x": None, "y": 2}, {"moving": True, "x": 1, "y": float("nan")},
                        {"moving": True, "x": True, "y": 2}):
            self.assertIsNone(track_from_event(message, NOW), message)


if __name__ == "__main__":
    unittest.main()
