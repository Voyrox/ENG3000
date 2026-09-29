"""
Tests for the V1-vs-V2 chain comparison tool in Website/tools/.

Every session is synthetic and built here; no data files, no plotting.
Standard library only.

    python -m unittest discover -s Website/tests
"""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
WEBSITE = os.path.dirname(HERE)
sys.path.insert(0, WEBSITE)
sys.path.insert(0, os.path.join(WEBSITE, "tools"))

from filterRules import STATUS_NO_SIGNAL, STATUS_OK, PlayArea  # noqa: E402
import compare_chains  # noqa: E402
from chain_replay import (  # noqa: E402
    count_alarm_episodes,
    count_cell_changes,
    replay_v1,
    replay_v2,
)
from session_readers import (  # noqa: E402
    Reading,
    read_game_log_csv,
    read_session,
    read_simple_csv,
)

LEFT, CENTRE, RIGHT = 0, 1, 2

READING_PERIOD_MS = 60.0    # one sensor's cycle; ultrasonic cycles are >= 60 ms apart
STAGGER_MS = 20.0           # offset between the three sensors' cycles
STAND_CM = 80.0             # default play area: rows 40 cm deep from 20 cm, so row 1
STAND_CELL = (CENTRE, 1)
CLOSE_CM = 5.0              # below the 10 cm alert floor
FRAME_HZ = 60.0


def centre_track(distances_cm, start_ms=0.0):
    """Centre-sensor readings, one per cycle, from a list of distances."""
    return [Reading(start_ms + k * READING_PERIOD_MS, CENTRE, d)
            for k, d in enumerate(distances_cm)]


def three_sensor_session(centre_cm, side_cm=None):
    """All three sensors reporting, staggered; the sides read side_cm."""
    readings = []
    for k, d in enumerate(centre_cm):
        base = k * READING_PERIOD_MS
        readings.append(Reading(base, LEFT, side_cm))
        readings.append(Reading(base + STAGGER_MS, CENTRE, d))
        readings.append(Reading(base + 2 * STAGGER_MS, RIGHT, side_cm))
    return readings


def standing(n):
    return [STAND_CM] * n


class Counts(unittest.TestCase):

    def test_cell_changes_skip_gaps(self):
        a, b = (1, 1), (1, 2)
        self.assertEqual(count_cell_changes([a, a, b, b, a]), 2)
        self.assertEqual(count_cell_changes([a, None, b]), 0)
        self.assertEqual(count_cell_changes([]), 0)

    def test_alarm_episodes_count_entries(self):
        statuses = ["ok", "too-close", "too-close", "ok", "too-close"]
        self.assertEqual(count_alarm_episodes(statuses), 2)
        self.assertEqual(count_alarm_episodes(["too-close"]), 1)
        self.assertEqual(count_alarm_episodes(["ok", "no-signal"]), 0)


class Replay(unittest.TestCase):

    def setUp(self):
        self.area = PlayArea.default()

    def test_standing_still_is_steady_in_both_chains(self):
        readings = three_sensor_session(standing(50))
        v1 = replay_v1(readings, self.area, FRAME_HZ)
        v2 = replay_v2(readings, self.area)
        for trace in (v1, v2):
            self.assertEqual(count_cell_changes(trace.cell), 0, trace.name)
            self.assertEqual(count_alarm_episodes(trace.status), 0, trace.name)
            self.assertEqual(trace.cell[-1], STAND_CELL, trace.name)
            self.assertAlmostEqual(trace.filtered_cm[-1][CENTRE], STAND_CM, places=6)
        self.assertAlmostEqual(v2.predicted_cm[-1][CENTRE], STAND_CM, delta=0.5)
        self.assertIsNone(v2.predicted_cm[-1][LEFT])

    def test_v1_runs_once_per_frame_and_v2_once_per_reading(self):
        readings = centre_track(standing(50))
        v1 = replay_v1(readings, self.area, FRAME_HZ)
        v2 = replay_v2(readings, self.area)
        duration_ms = readings[-1].t_ms - readings[0].t_ms
        expected_frames = int(duration_ms * FRAME_HZ / 1000.0) + 2   # plus one frame after the last
        self.assertLessEqual(abs(len(v1.t_ms) - expected_frames), 1)
        self.assertEqual(len(v2.t_ms), len(readings))
        self.assertEqual(v2.t_ms, [r.t_ms for r in readings])

    def test_a_frame_never_sees_a_reading_from_its_future(self):
        readings = centre_track([STAND_CM, 100.0])
        v1 = replay_v1(readings, self.area, FRAME_HZ)
        for t_ms, filtered in zip(v1.t_ms, v1.filtered_cm):
            if t_ms < readings[1].t_ms:
                self.assertEqual(filtered[CENTRE], STAND_CM)

    def test_one_close_reading_alarms_v1_per_frame_but_not_v2(self):
        # V1 counted its two-frame confirmation in animation frames, so one
        # reading that persists for ~3.6 frames confirmed itself. V2 counts
        # readings. One sensor only, so no other sensor re-evaluates it.
        track = standing(20) + [CLOSE_CM] + standing(20)
        readings = centre_track(track)
        v1 = replay_v1(readings, self.area, FRAME_HZ)
        v2 = replay_v2(readings, self.area)
        self.assertEqual(count_alarm_episodes(v1.status), 1)
        self.assertEqual(count_alarm_episodes(v2.status), 0)

    def test_sustained_approach_alarms_both_chains_once(self):
        approach = [STAND_CM - 5.0 * k for k in range(15)]          # 80 -> 10 cm
        track = standing(10) + approach + [CLOSE_CM] * 15 + standing(10)
        readings = centre_track(track)
        for trace in (replay_v1(readings, self.area, FRAME_HZ), replay_v2(readings, self.area)):
            self.assertEqual(count_alarm_episodes(trace.status), 1, trace.name)

    def test_v1_rejects_one_spike_once_per_frame(self):
        # The slew gate sees the same implausible reading on every frame
        # until the next one arrives; V2 sees it once.
        track = standing(20) + [STAND_CM + 60.0] + standing(20)
        readings = centre_track(track)
        v1 = replay_v1(readings, self.area, FRAME_HZ)
        v2 = replay_v2(readings, self.area)
        self.assertEqual(v2.rejected[CENTRE], 1)
        self.assertGreater(v1.rejected[CENTRE], v2.rejected[CENTRE])

    def test_no_echo_is_missing_not_zero(self):
        readings = centre_track([None] * 20)
        for trace in (replay_v1(readings, self.area, FRAME_HZ), replay_v2(readings, self.area)):
            self.assertEqual(count_alarm_episodes(trace.status), 0, trace.name)
            self.assertEqual(trace.status[-1], STATUS_NO_SIGNAL, trace.name)

    def test_moving_one_row_changes_the_cell_in_both_chains(self):
        track = standing(40) + [STAND_CM + 40.0] * 40                # row 1 -> row 2
        readings = centre_track(track)
        for trace in (replay_v1(readings, self.area, FRAME_HZ), replay_v2(readings, self.area)):
            self.assertEqual(count_cell_changes(trace.cell), 1, trace.name)
            self.assertEqual(trace.cell[-1], (CENTRE, 2), trace.name)
            self.assertEqual(trace.status[-1], STATUS_OK, trace.name)

    def test_empty_session(self):
        self.assertEqual(replay_v1([], self.area).t_ms, [])
        self.assertEqual(replay_v2([], self.area).t_ms, [])


class Readers(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, name, text):
        path = os.path.join(self.dir, name)
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        return path

    def test_simple_csv(self):
        path = self.write("s.csv", "# comment\n"
                                   "t_s,sensor,raw_cm\n"
                                   "0.10,center,-1\n"
                                   "0.00,left,82.5\n"
                                   "0.20,R,\n"
                                   "oops,left,1\n"
                                   "0.30,2,40\n")
        session = read_simple_csv(path)
        self.assertEqual([(r.t_ms, r.slot, r.distance_cm) for r in session.readings],
                         [(0.0, LEFT, 82.5), (100.0, CENTRE, None),
                          (200.0, RIGHT, None), (300.0, RIGHT, 40.0)])
        self.assertEqual(session.source, "s.csv")
        self.assertIsNone(session.per_column)
        self.assertEqual(len(session.notes), 2)      # one skipped, one out of order

    def game_log(self, name, rows):
        header = "t,screen,left_raw_cm,centre_raw_cm,right_raw_cm,status\n"
        return self.write(name, header + "".join(
            f"{t},game,{l},{c},{r},ok\n" for t, l, c, r in rows))

    def test_game_log_keeps_only_changes(self):
        path = self.game_log("game-001.csv", [
            (10, "", "80", ""),
            (20, "", "80", "50"),       # right reported; centre repeated
            (30, "", "81", "50"),       # centre reported
            (40, "", "", "50"),         # centre lost its echo
            (50, "", "", "50"),
        ])
        session = read_game_log_csv(path)
        self.assertEqual([(r.t_ms, r.slot, r.distance_cm) for r in session.readings],
                         [(10.0, CENTRE, 80.0), (20.0, RIGHT, 50.0),
                          (30.0, CENTRE, 81.0), (40.0, CENTRE, None)])
        self.assertIsNone(session.per_column)

    def test_game_log_reads_paired_calibration(self):
        path = self.game_log("game-002.csv", [(0, "", "80", "")])
        per_column = [{"near": 10.0, "far": 120.0}, {"near": 12.0, "far": 130.0},
                      {"near": 11.0, "far": 140.0}]
        self.write("game-002.json", json.dumps(
            {"calibration": {"calibrated": True, "perColumn": per_column}}))
        session = read_session(path)
        self.assertEqual(session.per_column, ((10.0, 120.0), (12.0, 130.0), (11.0, 140.0)))

    def test_game_log_ignores_incomplete_calibration(self):
        path = self.game_log("game-003.csv", [(0, "", "80", "")])
        self.write("game-003.json", json.dumps(
            {"calibration": {"calibrated": False, "perColumn": []}}))
        self.assertIsNone(read_session(path).per_column)

    def test_unknown_format_is_refused(self):
        path = self.write("x.csv", "a,b,c\n1,2,3\n")
        with self.assertRaises(ValueError):
            read_session(path)


class CommandLine(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.session_path = os.path.join(self._tmp.name, "session.csv")
        with open(self.session_path, "w", encoding="utf-8", newline="") as handle:
            handle.write("t_s,sensor,raw_cm\n")
            for r in centre_track(standing(20) + [CLOSE_CM] + standing(20)):
                handle.write(f"{r.t_ms / 1000.0:.3f},centre,{r.distance_cm}\n")

    def tearDown(self):
        self._tmp.cleanup()

    def test_prints_counts_per_chain(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(compare_chains.main([self.session_path, "--no-plot"]), 0)
        text = out.getvalue()
        v1_line = next(l for l in text.splitlines() if l.startswith("V1 "))
        v2_line = next(l for l in text.splitlines() if l.startswith("V2 "))
        # steps, cell changes, alarm episodes
        self.assertEqual(v1_line.split()[2:4], ["0", "1"])
        self.assertEqual(v2_line.split()[1:4], ["41", "0", "0"])

    def test_out_is_required_for_a_plot(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            compare_chains.main([self.session_path])

    def test_missing_matplotlib_is_a_clear_error(self):
        out_png = os.path.join(self._tmp.name, "plot.png")
        blocked = {"matplotlib": None, "matplotlib.pyplot": None}
        with mock.patch.dict(sys.modules, blocked), \
                contextlib.redirect_stdout(io.StringIO()), \
                self.assertRaises(SystemExit) as caught:
            compare_chains.main([self.session_path, "--out", out_png])
        self.assertIn("matplotlib", str(caught.exception.code))
        self.assertFalse(os.path.exists(out_png))

    def test_per_column_option(self):
        self.assertEqual(compare_chains.parse_per_column("10,120 12,130 11,140"),
                         ((10.0, 120.0), (12.0, 130.0), (11.0, 140.0)))
        with self.assertRaises(ValueError):
            compare_chains.parse_per_column("10,120")


if __name__ == "__main__":
    unittest.main()
