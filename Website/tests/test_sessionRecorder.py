"""
Tests for sessionRecorder.py, the raw-reading recorder, and its hooks in app.py
(the recorder call in update_node, turn_since in set_turn, and the two routes
the bench test drives).

Every file goes to a temporary directory; nothing binds a port.

    python -m unittest discover -s Website/tests
"""

import csv
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import app  # noqa: E402
from sessionRecorder import COLUMNS, SessionRecorder, clean_label, format_number  # noqa: E402
from test_app import BrokerTestCase, RecordingConn  # noqa: E402


class FakeClock:
    def __init__(self, now=100.0):
        self.now = now

    def __call__(self):
        return self.now


def read_rows(path):
    with open(path, newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


class TempDirCase(unittest.TestCase):

    def setUp(self):
        super().setUp()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def make_recorder(self, clock=None):
        recorder = SessionRecorder(self.dir / "raw.csv", clock=clock or FakeClock())
        self.addCleanup(recorder.close)
        return recorder


class SessionRecorderTests(TempDirCase):

    def test_it_is_off_without_rec(self):
        self.assertIsNone(SessionRecorder.from_env({}, directory=self.dir))
        self.assertIsNone(SessionRecorder.from_env({"REC": "0"}, directory=self.dir))
        self.assertEqual(list(self.dir.iterdir()), [])

    def test_rec_1_opens_a_timestamped_file_with_the_header(self):
        recorder = SessionRecorder.from_env({"REC": "1"}, directory=self.dir,
                                            now=datetime(2026, 10, 1, 9, 5, 7))
        self.addCleanup(recorder.close)
        self.assertEqual(recorder.path, self.dir / "raw-20261001-090507.csv")
        with open(recorder.path, newline="", encoding="utf-8") as handle:
            self.assertEqual(tuple(next(csv.reader(handle))), COLUMNS)

    def test_a_reading_is_written_as_sent_without_the_mac(self):
        clock = FakeClock(100.0)
        recorder = self.make_recorder(clock)
        payload = {"nodeId": 1, "mac": "AA:BB:CC:DD:EE:FF", "avg": 82.4, "left": 81.9,
                   "right": -1, "angle": 112, "scanState": 1}
        recorder.record(1, payload, role="LEFT", has_turn=True, ms_since_turn=412.6,
                        pulses=3, received_at=102.5)
        row = read_rows(recorder.path)[0]
        self.assertEqual(row, {
            "t_s": "2.500", "label": "", "node_id": "1", "role": "LEFT", "has_turn": "1",
            "ms_since_turn": "413", "pulses": "3", "left_cm": "81.90", "right_cm": "-1",
            "avg_cm": "82.40", "angle_deg": "112", "scan_state": "1",
        })
        self.assertNotIn("AA:BB:CC", recorder.path.read_text(encoding="utf-8"))

    def test_fields_the_node_did_not_send_are_left_empty(self):
        recorder = self.make_recorder()
        recorder.record(2, {"avg": 50}, received_at=100.0)
        row = read_rows(recorder.path)[0]
        self.assertEqual((row["role"], row["has_turn"], row["ms_since_turn"], row["pulses"]),
                         ("", "0", "", ""))
        self.assertEqual((row["avg_cm"], row["left_cm"], row["angle_deg"], row["scan_state"]),
                         ("50", "", "", ""))

    def test_the_handshake_line_is_not_a_reading(self):
        recorder = self.make_recorder()
        recorder.record(1, {"nodeId": -1, "mac": "AA:BB:CC:DD:EE:FF"}, received_at=100.0)
        recorder.record(1, {}, received_at=100.0)
        self.assertEqual(read_rows(recorder.path), [])

    def test_a_label_applies_to_the_readings_after_it_only(self):
        recorder = self.make_recorder()
        recorder.record(1, {"avg": 60}, received_at=100.0)
        self.assertEqual(recorder.set_label("p3-60cm"), "p3-60cm")
        recorder.record(1, {"avg": 61}, received_at=100.1)
        recorder.set_label("")
        recorder.record(1, {"avg": 62}, received_at=100.2)
        self.assertEqual([row["label"] for row in read_rows(recorder.path)],
                         ["", "p3-60cm", ""])

    def test_every_row_is_on_disk_straight_away(self):
        recorder = self.make_recorder()
        recorder.record(1, {"avg": 60}, received_at=100.0)
        self.assertEqual(len(read_rows(recorder.path)), 1)   # not closed yet

    def test_a_closed_recorder_ignores_late_readings(self):
        recorder = self.make_recorder()
        recorder.close()
        recorder.record(1, {"avg": 60})


class HelperTests(unittest.TestCase):

    def test_labels_keep_only_safe_characters_and_are_capped(self):
        self.assertEqual(clean_label("p3 60cm/../x"), "p360cm..x")
        self.assertEqual(clean_label(None), "")
        self.assertEqual(len(clean_label("a" * 100)), 40)

    def test_numbers_are_written_plainly_and_junk_as_empty(self):
        self.assertEqual(format_number(-1), "-1")
        self.assertEqual(format_number(-1.0), "-1")
        self.assertEqual(format_number(82.4), "82.40")
        self.assertEqual(format_number("64"), "64")
        for junk in (None, True, "left", float("nan"), float("inf"), [1]):
            self.assertEqual(format_number(junk), "", junk)


class AppRecorderTests(BrokerTestCase):
    """app.py feeds the recorder and exposes it to the bench test."""

    def setUp(self):
        super().setUp()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.recorder = SessionRecorder(Path(self._tmp.name) / "raw.csv")
        self.addCleanup(self.recorder.close)
        patcher = mock.patch.object(app, "recorder", self.recorder)
        patcher.start()
        self.addCleanup(patcher.stop)
        self._saved_roles = dict(app.node_roles)
        self._saved_pulses = app.nodes_pulse_count
        app.node_roles.clear()
        app.nodes_pulse_count = 1

    def tearDown(self):
        app.node_roles.clear()
        app.node_roles.update(self._saved_roles)
        app.nodes_pulse_count = self._saved_pulses
        super().tearDown()

    def rows(self):
        return read_rows(self.recorder.path)

    def test_each_reading_is_recorded_with_the_turn_role_and_pulses(self):
        node_id, _ = self.add_node(conn=RecordingConn())
        app.node_roles[node_id] = "RIGHT"
        app.nodes_pulse_count = 3
        app.set_turn(node_id, True)
        app.update_node(node_id, json.dumps({"avg": 70.5, "left": 70, "right": 71,
                                             "angle": 80, "scanState": 0}))
        (row,) = self.rows()
        self.assertEqual((row["node_id"], row["role"], row["has_turn"], row["pulses"]),
                         (str(node_id), "RIGHT", "1", "3"))
        self.assertGreaterEqual(float(row["ms_since_turn"]), 0)
        self.assertEqual((row["avg_cm"], row["scan_state"]), ("70.50", "0"))

    def test_a_reading_without_the_turn_says_so(self):
        node_id, _ = self.add_node(conn=RecordingConn())
        app.update_node(node_id, '{"avg": 40}')
        (row,) = self.rows()
        self.assertEqual((row["has_turn"], row["ms_since_turn"]), ("0", ""))

    def test_nothing_is_recorded_when_recording_is_off(self):
        node_id, _ = self.add_node(conn=RecordingConn())
        with mock.patch.object(app, "recorder", None):
            app.update_node(node_id, '{"avg": 40}')
        self.assertEqual(self.rows(), [])

    def test_the_turn_start_is_kept_across_repeated_grants_and_cleared_by_halt(self):
        node_id, node = self.add_node(conn=RecordingConn())
        with mock.patch.object(app.time, "monotonic", return_value=50.0):
            app.set_turn(node_id, True)
        with mock.patch.object(app.time, "monotonic", return_value=51.0):
            app.set_turn(node_id, True)          # a lone node is re-granted every tick
        self.assertEqual(node["turn_since"], 50.0)
        self.assertEqual(app.ms_since_turn(node, 50.25), 250.0)
        app.set_turn(node_id, False)
        self.assertIsNone(node["turn_since"])
        self.assertIsNone(app.ms_since_turn(node, 52.0))


class BenchRouteTests(BrokerTestCase):

    def setUp(self):
        super().setUp()
        self.client = app.app.test_client()
        self._saved_pulses = app.nodes_pulse_count
        app.nodes_pulse_count = 1

    def tearDown(self):
        app.nodes_pulse_count = self._saved_pulses
        super().tearDown()

    def test_labelling_without_a_recording_is_404(self):
        with mock.patch.object(app, "recorder", None):
            response = self.client.post("/api/recording/label", json={"label": "p1-30cm"})
        self.assertEqual(response.status_code, 404)

    def test_a_label_is_cleaned_set_and_echoed_with_the_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            recorder = SessionRecorder(Path(tmp) / "raw-x.csv")
            try:
                with mock.patch.object(app, "recorder", recorder):
                    response = self.client.post("/api/recording/label",
                                                json={"label": "p3 60cm"})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.get_json(), {"label": "p360cm", "file": "raw-x.csv"})
                self.assertEqual(recorder.label, "p360cm")
            finally:
                recorder.close()

    def test_pulses_can_be_set_without_the_game_page(self):
        _, node = self.add_node(conn=RecordingConn())
        response = self.client.post("/api/pulses", json={"count": 3})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(app.nodes_pulse_count, 3)
        self.assertEqual(node["conn"].sent, ["PULSES 3\n"])

    def test_a_bad_pulse_count_is_400_and_changes_nothing(self):
        for body in ({"count": 4}, {"count": "3"}, {"count": True}, {}, None):
            response = self.client.post("/api/pulses", json=body)
            self.assertEqual(response.status_code, 400, body)
        self.assertEqual(app.nodes_pulse_count, 1)


if __name__ == "__main__":
    unittest.main()
