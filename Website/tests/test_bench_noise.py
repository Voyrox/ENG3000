"""
Tests for Website/tools/bench_noise.py, the bench noise test.

The recording is synthetic and built here, with numbers worked out by hand;
the capture walk-through runs against a fake server. Standard library only.

    python -m unittest discover -s Website/tests
"""

import csv
import os
import sys
import tempfile
import unittest
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
WEBSITE = os.path.dirname(HERE)
sys.path.insert(0, WEBSITE)
sys.path.insert(0, os.path.join(WEBSITE, "tools"))

import bench_noise  # noqa: E402
from sessionRecorder import COLUMNS  # noqa: E402


def row(t, label, node_id, role, avg, has_turn=1, ms=None, pulses=1, state=0):
    return {"t_s": f"{t:.3f}", "label": label, "node_id": node_id, "role": role,
            "has_turn": has_turn, "ms_since_turn": "" if ms is None else ms, "pulses": pulses,
            "left_cm": avg, "right_cm": "", "avg_cm": avg, "angle_deg": 90, "scan_state": state}


# Step p1-60cm, LEFT: seven readings on the turn, one without it.
#   avg: 60 90 61 59 60 62 -1 60   (90 is the outlier, -1 a no echo)
#   echoes sorted: 59 60 60 60 61 62 90 -> median 60, bias 0
#   |deviation|: 0 0 0 1 1 2 30 -> MAD 1 -> sigma 1.4826; 1 of 7 over 10 cm
#   scanState: 0 0 0 1 0 2 2 0 -> 5 of 8 found
#   hand-over: 60 and 90 arrive within 150 ms of the TURN (1 outlier of 2),
#   the next five later (0 outliers of 4 echoes, 1 no echo of 5), 1 off-turn
LEFT_STEP = [
    row(1.00, "p1-60cm", 1, "LEFT", 60, ms=50),
    row(1.05, "p1-60cm", 1, "LEFT", 90, ms=100, state=0),
    row(1.10, "p1-60cm", 1, "LEFT", 61, ms=200),
    row(1.15, "p1-60cm", 1, "LEFT", 59, ms=300, state=1),
    row(1.20, "p1-60cm", 1, "LEFT", 60, ms=400),
    row(1.25, "p1-60cm", 1, "LEFT", 62, ms=500, state=2),
    row(1.30, "p1-60cm", 1, "LEFT", -1, ms=600, state=2),
    row(1.35, "p1-60cm", 1, "LEFT", 60, has_turn=0),
]
RIGHT_STEP = [row(2.0 + i / 10, "p1-60cm", 2, "RIGHT", 58, ms=300 + i) for i in range(3)]
PULSES_3_STEP = [row(3.0, "p3-90cm", 1, "LEFT", 91, ms=400, pulses=3),
                 row(3.1, "p3-90cm", 1, "LEFT", 89, ms=500, pulses=3)]
UNLABELLED = [row(0.5, "", 1, "LEFT", 5), row(2.5, "", 2, "RIGHT", 300)]


class RecordingCase(unittest.TestCase):

    def write(self, rows):
        handle = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, newline="",
                                             encoding="utf-8")
        with handle:
            writer = csv.DictWriter(handle, fieldnames=COLUMNS)
            writer.writeheader()
            writer.writerows(rows)
        self.addCleanup(os.remove, handle.name)
        return handle.name

    def recording(self):
        return self.write(UNLABELLED[:1] + LEFT_STEP + RIGHT_STEP + UNLABELLED[1:] + PULSES_3_STEP)


class StatsTests(RecordingCase):

    def stats(self):
        rows = bench_noise.read_recording(self.recording())
        return {(s.label, s.node, s.pulses, s.signal): s for s in bench_noise.summarise(rows)}

    def test_the_numbers_for_one_step_match_the_hand_worked_ones(self):
        stat = self.stats()[("p1-60cm", "LEFT", 1, "avg")]
        self.assertEqual(stat.n, 8)
        self.assertAlmostEqual(stat.no_echo_pct, 12.5)
        self.assertEqual(stat.median_cm, 60)
        self.assertEqual(stat.bias_cm, 0)
        self.assertAlmostEqual(stat.robust_sigma_cm, 1.4826)
        self.assertAlmostEqual(stat.outlier_pct, 100 / 7)
        self.assertAlmostEqual(stat.found_pct, 62.5)
        self.assertGreater(stat.std_cm, 10)    # the outlier inflates std, not sigma

    def test_steps_are_grouped_by_label_node_and_pulses_in_recorded_order(self):
        keys = list(dict.fromkeys(key[:3] for key in self.stats()))
        self.assertEqual(keys, [("p1-60cm", "LEFT", 1), ("p1-60cm", "RIGHT", 1),
                                ("p3-90cm", "LEFT", 3)])

    def test_bias_comes_from_the_distance_in_the_label(self):
        stats = self.stats()
        self.assertEqual(stats[("p1-60cm", "RIGHT", 1, "avg")].bias_cm, -2)
        self.assertEqual(stats[("p3-90cm", "LEFT", 3, "avg")].median_cm, 90)
        self.assertEqual(stats[("p3-90cm", "LEFT", 3, "avg")].bias_cm, 0)

    def test_unlabelled_readings_are_left_out(self):
        stats = self.stats()
        self.assertEqual(stats[("p1-60cm", "RIGHT", 1, "avg")].n, 3)
        self.assertNotIn("", {key[0] for key in stats})

    def test_a_sensor_the_node_did_not_send_has_no_numbers(self):
        stat = self.stats()[("p1-60cm", "LEFT", 1, "right")]
        self.assertEqual(stat.n, 0)
        self.assertIsNone(stat.median_cm)
        self.assertIsNone(stat.no_echo_pct)

    def test_a_step_with_only_no_echoes_is_all_no_echo(self):
        path = self.write([row(0, "p1-30cm", 1, "LEFT", -1), row(0.1, "p1-30cm", 1, "LEFT", -1)])
        (stat,) = [s for s in bench_noise.summarise(bench_noise.read_recording(path))
                   if s.signal == "avg"]
        self.assertEqual((stat.n, stat.no_echo_pct, stat.median_cm), (2, 100.0, None))

    def test_true_distance_is_read_from_the_label(self):
        self.assertEqual(bench_noise.true_distance_cm("p3-60cm"), 60.0)
        self.assertEqual(bench_noise.true_distance_cm("p1-60.5cm"), 60.5)
        self.assertIsNone(bench_noise.true_distance_cm("warmup"))


class HandoverTests(RecordingCase):

    def test_readings_just_after_the_turn_are_judged_apart(self):
        rows = bench_noise.read_recording(self.recording())
        left = {h.node: h for h in bench_noise.handover(rows)}["LEFT"]
        self.assertEqual(left.off_turn, 1)
        self.assertEqual(left.early_n, 2)
        self.assertAlmostEqual(left.early_outlier_pct, 50.0)
        self.assertAlmostEqual(left.early_no_echo_pct, 0.0)
        self.assertEqual(left.late_n, 7)          # five from p1-60cm, two from p3-90cm
        self.assertAlmostEqual(left.late_outlier_pct, 0.0)
        self.assertAlmostEqual(left.late_no_echo_pct, 100 / 7)


class ReportTests(RecordingCase):

    def test_the_report_prints_both_tables(self):
        lines = []
        self.assertEqual(bench_noise.report(self.recording(), out=lines.append), 0)
        text = "\n".join(lines)
        self.assertIn("p1-60cm", text)
        self.assertIn("outlier%", text)
        self.assertIn("off-turn", text)

    def test_the_table_can_also_go_to_a_csv(self):
        out_path = self.write([])
        bench_noise.report(self.recording(), csv_out=out_path, out=lambda *_: None)
        with open(out_path, newline="", encoding="utf-8") as handle:
            table = list(csv.reader(handle))
        self.assertEqual(tuple(table[0]), bench_noise.STATS_HEADERS)
        self.assertEqual(len(table), 1 + 3 * 3)   # three steps x three signals

    def test_a_recording_without_labels_says_how_to_make_one(self):
        lines = []
        self.assertEqual(bench_noise.report(self.write(UNLABELLED), out=lines.append), 1)
        self.assertIn("capture", lines[0])


class FakeServer:
    """Stands in for post_json: records every POST, answers like app.py."""

    def __init__(self, label_status=200):
        self.calls = []
        self.label_status = label_status

    def __call__(self, url, body):
        self.calls.append((url.rsplit("/api/", 1)[1], body))
        if url.endswith("/recording/label"):
            return self.label_status, {"label": body["label"], "file": "raw-test.csv"}
        return 200, {"count": body["count"]}

    def sequence(self):
        return [(path, body.get("label", body.get("count"))) for path, body in self.calls]


class CaptureTests(unittest.TestCase):

    def run_capture(self, server, **kwargs):
        prompts, lines = [], []
        code = bench_noise.capture("http://pc:5000", [30, 60], [1, 3], seconds=20, settle_s=2,
                                   post=server, prompt=prompts.append, sleep=lambda _s: None,
                                   out=lines.append, **kwargs)
        return code, prompts, lines

    def test_each_step_is_set_up_labelled_and_closed_in_order(self):
        server = FakeServer()
        code, prompts, lines = self.run_capture(server)
        self.assertEqual(code, 0)
        self.assertEqual(server.sequence(), [
            ("recording/label", ""),
            ("pulses", 1),
            ("recording/label", "p1-30cm"), ("recording/label", ""),
            ("recording/label", "p1-60cm"), ("recording/label", ""),
            ("pulses", 3),
            ("recording/label", "p3-30cm"), ("recording/label", ""),
            ("recording/label", "p3-60cm"), ("recording/label", ""),
            ("recording/label", ""), ("pulses", 1),       # tidy up: no label, Pulses off
        ])
        self.assertEqual(len(prompts), 4)
        self.assertIn("30 cm", prompts[0])
        self.assertIn("report logs/raw-test.csv", lines[-1])

    def test_a_server_that_is_not_recording_is_explained(self):
        code, _, lines = self.run_capture(FakeServer(label_status=404))
        self.assertEqual(code, 1)
        self.assertIn("REC=1", lines[0])

    def test_an_unreachable_server_is_explained(self):
        def down(url, body):
            raise urllib.error.URLError("connection refused")

        code, _, lines = self.run_capture(down)
        self.assertEqual(code, 1)
        self.assertIn("Cannot reach", lines[0])

    def test_step_labels_name_the_pulses_and_distance(self):
        self.assertEqual(bench_noise.step_label(3, 60.0), "p3-60cm")
        self.assertEqual(bench_noise.step_label(1, 60.5), "p1-60.5cm")


if __name__ == "__main__":
    unittest.main()
