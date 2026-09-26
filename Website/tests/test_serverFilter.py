"""
Tests for server-side filtering behind the SERVER_FILTERING flag.

  * serverFilter.py on its own (standard library only).
  * app.py with the flag off and on. These need the server's requirements
    (Flask, websockets, numpy) and are skipped if they are not installed.

    python -m unittest discover -s Website/tests
"""

import importlib
import json
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from filterRules import (  # noqa: E402
    STATUS_OK,
    CoordinatePipeline,
    UltrasonicArrayGeometry,
)
from serverFilter import (  # noqa: E402
    SERVER_FILTERING_ENV,
    ServerFilterStage,
    server_filtering_enabled,
)

try:
    import app  # noqa: E402
except ImportError:  # server requirements not installed
    app = None

STEP_MS = 100.0          # 10 Hz, a typical node reporting rate
LEFT, CENTRE, RIGHT = 11, 12, 13   # node ids, deliberately not 1, 2, 3


class RecordingPipeline(CoordinatePipeline):
    """A real pipeline that records every update() call."""

    def __init__(self):
        super().__init__(UltrasonicArrayGeometry())
        self.calls = []

    def update(self, sample, now_ms, fresh=None):
        self.calls.append((list(sample), now_ms, fresh))
        return super().update(sample, now_ms, fresh=fresh)


def samples_in(pipeline, channel):
    """How many readings are in a channel's median window."""
    return len(pipeline._channels[channel]._samples)


class FlagDefault(unittest.TestCase):

    def test_off_when_unset(self):
        self.assertFalse(server_filtering_enabled({}))

    def test_off_for_other_values(self):
        for value in ("", "0", "false", "off", "no", "maybe"):
            self.assertFalse(server_filtering_enabled({SERVER_FILTERING_ENV: value}), value)

    def test_on_values(self):
        for value in ("1", "true", "TRUE", "yes", "on", " on "):
            self.assertTrue(server_filtering_enabled({SERVER_FILTERING_ENV: value}), value)


class StageOncePerReading(unittest.TestCase):

    def setUp(self):
        self.pipeline = RecordingPipeline()
        self.stage = ServerFilterStage(self.pipeline)
        self.stage.assign_slots([LEFT, CENTRE, RIGHT])

    def test_unassigned_node_runs_nothing(self):
        self.assertIsNone(self.stage.on_reading(99, 50.0, STEP_MS))
        self.assertEqual(self.pipeline.calls, [])

    def test_one_update_per_reading(self):
        for i, node in enumerate([LEFT, CENTRE, RIGHT, LEFT, CENTRE]):
            self.stage.on_reading(node, 60.0, (i + 1) * STEP_MS)
        self.assertEqual(len(self.pipeline.calls), 5)

    def test_only_reporting_channel_is_fresh(self):
        self.stage.on_reading(LEFT, 60.0, STEP_MS)
        self.stage.on_reading(CENTRE, 80.0, 2 * STEP_MS)
        sample, _, fresh = self.pipeline.calls[-1]
        self.assertEqual(sample, [60.0, 80.0, None])
        # Left is stale; right has no reading at all, which is safe to pass.
        self.assertEqual(fresh, [False, True, True])

    def test_stale_reading_is_not_refed(self):
        self.stage.on_reading(LEFT, 60.0, STEP_MS)
        for i in range(10):
            self.stage.on_reading(CENTRE, 80.0 + i, (i + 2) * STEP_MS)
        self.assertEqual(samples_in(self.pipeline, 0), 1)
        # The stale channel keeps its value rather than dropping out.
        self.assertEqual(self.stage.latest.filtered[0], 60.0)

    def test_new_reading_from_same_node_is_fed(self):
        for i in range(3):
            self.stage.on_reading(LEFT, 60.0, (i + 1) * STEP_MS)
        self.assertEqual(samples_in(self.pipeline, 0), 3)

    def test_offline_node_becomes_no_reading(self):
        self.stage.on_reading(LEFT, 60.0, STEP_MS)
        self.stage.on_missing(LEFT)
        self.stage.on_reading(CENTRE, 80.0, 2 * STEP_MS)
        sample, _, fresh = self.pipeline.calls[-1]
        self.assertIsNone(sample[0])
        self.assertTrue(fresh[0])

    def test_proximity_guard_still_sees_stale_raw(self):
        # Safety: a too-close reading on one sensor is not forgotten because
        # another sensor reported next. Two frames confirm it (too_close_frames).
        self.stage.on_reading(LEFT, 5.0, STEP_MS)
        result = self.stage.on_reading(CENTRE, 80.0, 2 * STEP_MS)
        self.assertEqual(result.status, "too-close")

    def test_assign_slots_needs_three(self):
        with self.assertRaises(ValueError):
            self.stage.assign_slots([LEFT, CENTRE])


class PipelineFreshMask(unittest.TestCase):

    def test_default_is_all_fresh(self):
        a = CoordinatePipeline(UltrasonicArrayGeometry())
        b = CoordinatePipeline(UltrasonicArrayGeometry())
        for i in range(5):
            now_ms = (i + 1) * STEP_MS
            ra = a.update([50.0, 70.0, 90.0], now_ms)
            rb = b.update([50.0, 70.0, 90.0], now_ms, fresh=[True, True, True])
            self.assertEqual(ra.to_dict(), rb.to_dict())

    def test_not_fresh_channel_is_not_updated(self):
        pipeline = CoordinatePipeline(UltrasonicArrayGeometry())
        pipeline.update([50.0, 70.0, 90.0], STEP_MS)
        pipeline.update([50.0, 71.0, 90.0], 2 * STEP_MS, fresh=[False, True, False])
        self.assertEqual([samples_in(pipeline, c) for c in range(3)], [1, 2, 1])


@unittest.skipIf(app is None, "server requirements (Flask, websockets, numpy) not installed")
class AppWiring(unittest.TestCase):

    def setUp(self):
        self._saved = (app.server_filter, dict(app.nodes))
        app.nodes.clear()
        for node_id in (LEFT, CENTRE, RIGHT):
            record = app.new_node(("10.0.0.1", 1000 + node_id))
            record["id"] = node_id
            app.nodes[node_id] = record

    def tearDown(self):
        app.server_filter, saved_nodes = self._saved
        app.nodes.clear()
        app.nodes.update(saved_nodes)

    def send(self, node_id, distance_cm):
        app.update_node(node_id, json.dumps({"distance": distance_cm}))

    def test_flag_off_by_default_on_import(self):
        env = {k: v for k, v in os.environ.items() if k != SERVER_FILTERING_ENV}
        with mock.patch.dict(os.environ, env, clear=True):
            reloaded = importlib.reload(app)
            try:
                self.assertFalse(reloaded.SERVER_FILTERING)
                self.assertIsNone(reloaded.server_filter)
            finally:
                importlib.reload(app)

    def test_flag_off_message_unchanged(self):
        app.server_filter = None
        self.send(LEFT, 60.0)
        message = app.nodes_message()
        self.assertEqual(list(message), ["type", "nodes"])
        self.assertEqual(message["type"], "nodes:update")
        self.assertEqual(message["nodes"], app.snapshot_nodes())
        self.assertEqual(list(message["nodes"][0]), [
            "id", "address", "latest", "filtered_distance", "online",
            "last_seen", "rps", "synced", "has_turn"])

    def test_flag_on_adds_coordinate_once_per_reading(self):
        pipeline = RecordingPipeline()
        app.server_filter = ServerFilterStage(pipeline)
        app.server_filter.assign_slots([LEFT, CENTRE, RIGHT])
        self.send(LEFT, 60.0)
        self.send(CENTRE, 90.0)
        self.send(RIGHT, 120.0)
        self.assertEqual(len(pipeline.calls), 3)
        message = app.nodes_message()
        # Existing fields untouched; the coordinate is an added field.
        self.assertEqual(list(message), ["type", "nodes", "coordinate"])
        self.assertEqual(message["nodes"], app.snapshot_nodes())
        self.assertEqual(message["coordinate"]["status"], STATUS_OK)
        self.assertEqual(message["coordinate"]["column"], 0)

    def test_flag_on_feeds_raw_not_filtered_distance(self):
        pipeline = RecordingPipeline()
        app.server_filter = ServerFilterStage(pipeline)
        app.server_filter.assign_slots([LEFT, CENTRE, RIGHT])
        self.send(LEFT, -1)                     # no echo
        self.assertEqual(pipeline.calls[-1][0][0], -1.0)
        self.assertIsNone(app.server_filter.latest.raw[0])

    def test_message_without_distance_is_not_a_reading(self):
        pipeline = RecordingPipeline()
        app.server_filter = ServerFilterStage(pipeline)
        app.server_filter.assign_slots([LEFT, CENTRE, RIGHT])
        app.update_node(LEFT, json.dumps({"mac": "aa:bb"}))
        self.assertEqual(pipeline.calls, [])

    def test_browser_assign_and_calibration(self):
        app.server_filter = ServerFilterStage()
        app.apply_filter_event({"type": "sensors:assign", "slots": [CENTRE, LEFT, RIGHT]})
        self.assertEqual(app.server_filter.sensor_slots, [CENTRE, LEFT, RIGHT])
        app.apply_filter_event({"type": "calibration:update", "perColumn": [
            {"near": 30.0, "far": 130.0}] * 3})
        self.assertTrue(app.server_filter.pipeline.area.is_calibrated)
        app.apply_filter_event({"type": "sensors:assign", "slots": [1]})   # ignored
        self.assertEqual(app.server_filter.sensor_slots, [CENTRE, LEFT, RIGHT])


if __name__ == "__main__":
    unittest.main()
