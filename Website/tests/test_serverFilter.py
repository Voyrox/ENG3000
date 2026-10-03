"""
Tests for server-side filtering behind the SERVER_FILTERING flag.

  * serverFilter.py on its own (standard library only), including the
    per-channel path-prediction trackers (#18).
  * app.py with the flag off and on. These need the server's requirements
    (Flask, websockets, numpy) and are skipped if they are not installed.

    python -m unittest discover -s Website/tests
"""

import asyncio
import importlib
import json
import math
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
from tracking import DEFAULT_GAP_RESET_S, DEFAULT_MAX_LEAD_S, PathPredictor  # noqa: E402

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


class RecordingPredictor(PathPredictor):
    """A real per-channel predictor that records every update() call."""

    def __init__(self):
        super().__init__(3)
        self.calls = []

    def update(self, channel, distance_cm, t_s):
        self.calls.append((channel, distance_cm, t_s))
        super().update(channel, distance_cm, t_s)


# Walking-pace ramp for the prediction tests, cm/s.
RAMP_SPEED_CM_S = 50.0
RAMP_START_CM = 60.0
# How far the tracker may miss a noiseless ramp after a few readings, cm.
RAMP_TOLERANCE_CM = 0.5


def ramp_cm(now_ms):
    return RAMP_START_CM + RAMP_SPEED_CM_S * now_ms / 1000.0


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


class StageTwoSensorRig(unittest.TestCase):
    """The default stage: LEFT and RIGHT only, placed by trilateration."""

    def test_centre_player_is_placed_from_left_and_right(self):
        stage = ServerFilterStage()
        stage.assign_slots([LEFT, None, RIGHT])
        distance = math.hypot(50.0, 100.0)          # player at x 75, depth 100
        stage.on_reading(LEFT, distance, STEP_MS)
        result = stage.on_reading(RIGHT, distance, 2 * STEP_MS)
        self.assertEqual(result.status, STATUS_OK)
        self.assertEqual(result.column, 1)
        self.assertAlmostEqual(result.x_cm, 75.0)
        self.assertAlmostEqual(result.y_cm, 100.0)

    def test_scanner_angles_place_the_player(self):
        # Each node 80 cm away, turned 30 degrees in towards the centre.
        stage = ServerFilterStage()
        stage.assign_slots([LEFT, None, RIGHT])
        stage.on_reading(LEFT, 80.0, STEP_MS, angle_deg=60)
        result = stage.on_reading(RIGHT, 80.0, 2 * STEP_MS, angle_deg=120)
        self.assertEqual(result.column, 1)
        self.assertAlmostEqual(result.x_cm, 75.0)
        self.assertAlmostEqual(result.y_cm, 80.0 * math.cos(math.radians(30)))

    def test_turn_discards_only_that_nodes_distance_history(self):
        stage = ServerFilterStage()
        stage.assign_slots([LEFT, None, RIGHT])
        for i in range(3):
            stage.on_reading(LEFT, 60.0, i * STEP_MS, angle_deg=90)
            stage.on_reading(RIGHT, 80.0, i * STEP_MS + 1, angle_deg=90)
        result = stage.on_reading(LEFT, 120.0, 3 * STEP_MS, angle_deg=110)
        self.assertEqual(result.filtered[0], 120.0)
        self.assertEqual(result.filtered[2], 80.0)
        self.assertEqual(samples_in(stage.pipeline, 0), 1)
        self.assertEqual(samples_in(stage.pipeline, 2), 3)
        self.assertEqual(stage.predicted_cm[0], 120.0)

    def test_new_angle_with_no_echo_does_not_project_old_range(self):
        stage = ServerFilterStage()
        stage.assign_slots([LEFT, None, RIGHT])
        stage.on_reading(LEFT, 60.0, STEP_MS, angle_deg=90)
        result = stage.on_reading(LEFT, -1.0, 2 * STEP_MS, angle_deg=110)
        self.assertIsNone(result.filtered[0])
        self.assertIsNone(stage.predicted_cm[0])

    def test_a_node_going_offline_forgets_its_angle(self):
        stage = ServerFilterStage()
        stage.assign_slots([LEFT, None, RIGHT])
        stage.on_reading(LEFT, 80.0, STEP_MS, angle_deg=60)
        stage.on_missing(LEFT)
        # Past the channel's hold window, so the left distance no longer coasts.
        result = stage.on_reading(RIGHT, 70.0, STEP_MS + 1000.0)
        # Neither node has an angle now, so the right one places the player
        # straight in front of itself, as before scanners.
        self.assertAlmostEqual(result.x_cm, 125.0)


class StagePathPrediction(unittest.TestCase):
    """The per-channel trackers behind the flag (#18)."""

    def setUp(self):
        self.pipeline = RecordingPipeline()
        self.predictor = RecordingPredictor()
        self.stage = ServerFilterStage(self.pipeline, self.predictor)
        self.stage.assign_slots([LEFT, CENTRE, RIGHT])

    def ramp(self, node, n, stage=None):
        """n noiseless ramp readings from one node; returns the last time, ms."""
        stage = stage or self.stage
        now_ms = 0.0
        for k in range(n):
            now_ms = k * STEP_MS
            stage.on_reading(node, ramp_cm(now_ms), now_ms)
        return now_ms

    def test_nothing_predicted_before_readings(self):
        self.assertEqual(self.stage.predicted_cm, [None, None, None])

    def test_each_node_feeds_its_own_channel(self):
        self.stage.on_reading(CENTRE, 80.0, STEP_MS)
        self.stage.on_reading(RIGHT, 120.0, 2 * STEP_MS)
        self.stage.on_reading(LEFT, 60.0, 3 * STEP_MS)
        self.assertEqual([c for c, _, _ in self.predictor.calls], [1, 2, 0])
        self.assertEqual([t.alive for t in self.predictor.trackers], [True, True, True])

    def test_tracker_gets_the_same_raw_reading_as_the_chain(self):
        for i, (node, cm) in enumerate([(LEFT, 60.0), (CENTRE, -1.0), (LEFT, 3.0)]):
            self.stage.on_reading(node, cm, (i + 1) * STEP_MS)
        self.assertEqual(len(self.pipeline.calls), len(self.predictor.calls))
        for (sample, now_ms, fresh), (channel, cm, t_s) in zip(self.pipeline.calls,
                                                               self.predictor.calls):
            self.assertTrue(fresh[channel])
            self.assertEqual(sample[channel], cm)
            self.assertAlmostEqual(t_s * 1000.0, now_ms, places=9)

    def test_one_tracker_update_per_reading(self):
        for i, node in enumerate([LEFT, CENTRE, RIGHT, LEFT, CENTRE]):
            self.stage.on_reading(node, 60.0, (i + 1) * STEP_MS)
        self.assertEqual(len(self.predictor.calls), 5)

    def test_unassigned_node_feeds_no_tracker(self):
        self.stage.on_reading(99, 50.0, STEP_MS)
        self.assertEqual(self.predictor.calls, [])

    def test_no_echo_is_not_zero(self):
        self.stage.on_reading(LEFT, -1.0, STEP_MS)
        self.assertIsNone(self.stage.predicted_cm[0])

    def test_follows_a_ramp(self):
        t_ms = self.ramp(LEFT, 10)
        self.assertAlmostEqual(self.stage.predicted_cm[0], ramp_cm(t_ms),
                               delta=RAMP_TOLERANCE_CM)

    def test_stale_channel_is_extrapolated_to_now(self):
        t_ms = self.ramp(LEFT, 10)
        later_ms = t_ms + STEP_MS
        self.stage.on_reading(CENTRE, 80.0, later_ms)
        self.assertAlmostEqual(self.stage.predicted_cm[0], ramp_cm(later_ms),
                               delta=RAMP_TOLERANCE_CM)
        self.assertEqual(self.stage.predicted_cm[1], 80.0)

    def test_lead_is_capped(self):
        stage = ServerFilterStage(prediction_lead_s=10.0)
        stage.assign_slots([LEFT, CENTRE, RIGHT])
        t_ms = self.ramp(LEFT, 10, stage)
        tracker = stage.predictor.trackers[0]
        self.assertEqual(stage.predicted_cm[0], tracker.predict(DEFAULT_MAX_LEAD_S))
        capped_ms = t_ms + DEFAULT_MAX_LEAD_S * 1000.0
        self.assertAlmostEqual(stage.predicted_cm[0], ramp_cm(capped_ms),
                               delta=RAMP_TOLERANCE_CM)

    def test_gap_reset(self):
        t_ms = self.ramp(LEFT, 10)
        # Only the centre reports for longer than the gap: left's track is
        # no longer extrapolated.
        gap_ms = DEFAULT_GAP_RESET_S * 1000.0 + STEP_MS
        self.stage.on_reading(CENTRE, 80.0, t_ms + gap_ms)
        self.assertIsNone(self.stage.predicted_cm[0])
        # The next left reading starts a new track at that reading.
        self.stage.on_reading(LEFT, 150.0, t_ms + gap_ms + STEP_MS)
        self.assertEqual(self.stage.predicted_cm[0], 150.0)
        self.assertEqual(self.predictor.trackers[0].velocity_cm_s, 0.0)

    def test_offline_node_drops_its_track(self):
        self.ramp(LEFT, 5)
        self.stage.on_reading(CENTRE, 80.0, 6 * STEP_MS)
        self.stage.on_missing(LEFT)
        self.assertIsNone(self.stage.predicted_cm[0])
        self.assertFalse(self.predictor.trackers[0].alive)
        self.assertEqual(self.stage.predicted_cm[1], 80.0)

    def test_assign_slots_resets_trackers(self):
        self.ramp(LEFT, 5)
        self.stage.assign_slots([CENTRE, LEFT, RIGHT])
        self.assertEqual(self.stage.predicted_cm, [None, None, None])
        self.assertFalse(any(t.alive for t in self.predictor.trackers))

    def test_coordinate_is_unchanged_by_the_trackers(self):
        # The trackers only publish: the chain's result is exactly what the
        # pipeline gives on its own, including the raw-reading too-close alert.
        readings = [(LEFT, 60.0), (CENTRE, 90.0), (LEFT, 200.0), (LEFT, 61.0),
                    (RIGHT, -1.0), (LEFT, 5.0), (CENTRE, 90.0), (LEFT, 62.0)]
        reference = CoordinatePipeline(UltrasonicArrayGeometry())
        slots = [LEFT, CENTRE, RIGHT]
        latest = {}
        statuses = set()
        for i, (node, cm) in enumerate(readings):
            now_ms = (i + 1) * STEP_MS
            latest[node] = cm
            sample = [latest.get(slot) for slot in slots]
            fresh = [slot == node or sample[c] is None for c, slot in enumerate(slots)]
            expected = reference.update(sample, now_ms, fresh=fresh)
            got = self.stage.on_reading(node, cm, now_ms)
            self.assertEqual(got.to_dict(), expected.to_dict())
            statuses.add(got.status)
        self.assertIn("too-close", statuses)


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
        # confidence is handover.py's, sent whatever the flag.
        self.assertEqual(list(message["nodes"][0]), [
            "id", "address", "latest", "filtered_distance", "online",
            "last_seen", "rps", "synced", "has_turn", "confidence"])

    def test_flag_on_adds_coordinate_once_per_reading(self):
        pipeline = RecordingPipeline()
        app.server_filter = ServerFilterStage(pipeline)
        app.server_filter.assign_slots([LEFT, CENTRE, RIGHT])
        self.send(LEFT, 60.0)
        self.send(CENTRE, 90.0)
        self.send(RIGHT, 120.0)
        self.assertEqual(len(pipeline.calls), 3)
        message = app.nodes_message()
        # Existing fields untouched; coordinate and predicted_cm are added.
        self.assertEqual(list(message), ["type", "nodes", "coordinate", "predicted_cm"])
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

    def test_flag_off_has_no_prediction(self):
        app.server_filter = None
        self.send(LEFT, 60.0)
        self.send(LEFT, 61.0)
        self.assertNotIn("predicted_cm", app.nodes_message())

    def test_flag_on_publishes_prediction_per_channel(self):
        app.server_filter = ServerFilterStage()
        app.server_filter.assign_slots([LEFT, CENTRE, RIGHT])
        self.send(LEFT, 60.0)
        self.send(RIGHT, 120.0)
        message = app.nodes_message()
        self.assertEqual(message["predicted_cm"], [60.0, None, 120.0])
        json.dumps(message)          # serialisable as sent

    def test_flag_on_prediction_is_a_copy(self):
        app.server_filter = ServerFilterStage()
        app.server_filter.assign_slots([LEFT, CENTRE, RIGHT])
        self.send(LEFT, 60.0)
        message = app.nodes_message()
        app.mark_node_offline(LEFT)
        self.assertEqual(message["predicted_cm"], [60.0, None, None])
        self.assertEqual(app.nodes_message()["predicted_cm"], [None, None, None])

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


class FakeBrowser:
    """Stands in for a browser WebSocket: yields the given messages, records
    what the server sends back."""

    def __init__(self, messages):
        self._messages = [json.dumps(m) if isinstance(m, dict) else m for m in messages]
        self.sent = []

    async def send(self, message):
        self.sent.append(json.loads(message))

    def __aiter__(self):
        return self._iterate()

    async def _iterate(self):
        for message in self._messages:
            yield message


# Shapes exactly as canvas.js sends them (syncServerFilterSetup).
ASSIGN = {"type": "sensors:assign", "slots": [LEFT, CENTRE, RIGHT]}
# Near edge 60 cm, far edge 150 cm: 30 cm rows. 85 cm is row 0 here but row 1
# of the default 20-140 cm area, so a test can tell whether it was applied.
CALIBRATED_NEAR_CM, CALIBRATED_FAR_CM = 60.0, 150.0
CALIBRATE = {"type": "calibration:update", "perColumn": [
    {"near": CALIBRATED_NEAR_CM, "far": CALIBRATED_FAR_CM}] * 3}
PROBE_CM = 85.0
TOO_CLOSE_MARGIN_CM = 5.0     # how far inside the alert threshold the too-close probe sits


@unittest.skipIf(app is None, "server requirements (Flask, websockets, numpy) not installed")
class BrowserMessages(unittest.TestCase):
    """The server half of the messages the browser now sends and reads."""

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

    def run_browser(self, *messages):
        browser = FakeBrowser(messages)
        asyncio.run(app.browser_handler(browser))
        return browser

    def send(self, node_id, distance_cm):
        app.update_node(node_id, json.dumps({"distance": distance_cm}))

    # --- the flag, as the browser detects it -------------------------------

    def test_flag_off_first_message_has_no_coordinate_key(self):
        app.server_filter = None
        browser = self.run_browser()
        self.assertEqual(browser.sent[0]["type"], "nodes:update")
        self.assertNotIn("coordinate", browser.sent[0])
        self.assertNotIn("predicted_cm", browser.sent[0])

    def test_flag_on_first_message_has_coordinate_key_before_setup(self):
        # canvas.js keys on the key being present, so it must be there (as
        # null) before any assignment or reading.
        app.server_filter = ServerFilterStage()
        browser = self.run_browser()
        self.assertIn("coordinate", browser.sent[0])
        self.assertIsNone(browser.sent[0]["coordinate"])
        self.assertEqual(browser.sent[0]["predicted_cm"], [None, None, None])

    def test_flag_off_ignores_setup_messages(self):
        app.server_filter = None
        browser = self.run_browser(ASSIGN, CALIBRATE)   # must not raise
        self.assertEqual(len(browser.sent), 1)
        self.assertIsNone(app.server_filter)

    # --- sensors:assign and calibration:update over the socket -------------

    def test_setup_messages_over_socket(self):
        app.server_filter = ServerFilterStage()
        self.run_browser(ASSIGN, CALIBRATE)
        self.assertEqual(app.server_filter.sensor_slots, [LEFT, CENTRE, RIGHT])
        area = app.server_filter.pipeline.area
        self.assertTrue(area.is_calibrated)
        self.assertEqual(area.per_column, ((CALIBRATED_NEAR_CM, CALIBRATED_FAR_CM),) * 3)

    def test_non_json_and_unknown_messages_are_ignored(self):
        app.server_filter = ServerFilterStage()
        self.run_browser("not json", {"type": "something:else"}, ASSIGN)
        self.assertEqual(app.server_filter.sensor_slots, [LEFT, CENTRE, RIGHT])

    def test_bad_calibration_leaves_area_unchanged(self):
        app.server_filter = ServerFilterStage()
        self.run_browser(CALIBRATE,
                         {"type": "calibration:update", "perColumn": [{"near": 1.0}] * 3},
                         {"type": "calibration:update", "perColumn": [{"near": 1.0, "far": 99.0}]},
                         {"type": "calibration:update", "perColumn": None})
        self.assertEqual(app.server_filter.pipeline.area.per_column,
                         ((CALIBRATED_NEAR_CM, CALIBRATED_FAR_CM),) * 3)

    def test_shallow_calibration_falls_back_like_the_browser(self):
        # The browser sends the points as captured; a column shallower than
        # the minimum depth falls back to defaults, as getBounds() does.
        app.server_filter = ServerFilterStage()
        self.run_browser({"type": "calibration:update", "perColumn": [
            {"near": 60.0, "far": 150.0}, {"near": 60.0, "far": 65.0},
            {"near": 60.0, "far": 150.0}]})
        self.assertFalse(app.server_filter.pipeline.area.is_calibrated)

    def test_calibration_changes_the_row(self):
        for message, expected_gy, calibrated in ((None, 1, False), (CALIBRATE, 0, True)):
            app.server_filter = ServerFilterStage()
            self.run_browser(*(m for m in (ASSIGN, message) if m is not None))
            self.send(LEFT, PROBE_CM)
            coordinate = app.nodes_message()["coordinate"]
            self.assertEqual(coordinate["status"], STATUS_OK)
            self.assertEqual((coordinate["gx"], coordinate["gy"]), (0, expected_gy))
            self.assertIs(coordinate["calibrated"], calibrated)

    def test_reassign_resets_the_filters(self):
        # Why canvas.js does not resend an unchanged assignment.
        app.server_filter = ServerFilterStage()
        self.run_browser(ASSIGN)
        self.send(LEFT, PROBE_CM)
        self.assertIsNotNone(app.nodes_message()["coordinate"])
        self.run_browser(ASSIGN)
        self.assertIsNone(app.nodes_message()["coordinate"])
        self.assertEqual(samples_in(app.server_filter.pipeline, 0), 0)

    def test_coordinate_has_every_field_game_js_reads(self):
        app.server_filter = ServerFilterStage()
        self.run_browser(ASSIGN, CALIBRATE)
        self.send(LEFT, PROBE_CM)
        coordinate = app.nodes_message()["coordinate"]
        for key in ("status", "x", "y", "gx", "gy", "rawGx", "rawGy", "column",
                    "held", "heldFor", "calibrated", "raw", "filtered"):
            self.assertIn(key, coordinate)
        # y is the distance used, x the column centre; lists are L, C, R.
        self.assertEqual(coordinate["y"], PROBE_CM)
        self.assertEqual(coordinate["x"], app.server_filter.pipeline.area.column_centre_cm(0))
        self.assertEqual(coordinate["raw"], [PROBE_CM, None, None])

    def test_too_close_reports_raw_distance_in_y(self):
        # The browser shows y on the alert screen for too-close.
        app.server_filter = ServerFilterStage()
        self.run_browser(ASSIGN, CALIBRATE)
        threshold_cm = app.server_filter.pipeline.area.alert_threshold_cm
        close_cm = threshold_cm - TOO_CLOSE_MARGIN_CM
        self.send(LEFT, close_cm)
        self.send(CENTRE, PROBE_CM)
        coordinate = app.nodes_message()["coordinate"]
        self.assertEqual(coordinate["status"], "too-close")
        self.assertEqual(coordinate["y"], close_cm)


if __name__ == "__main__":
    unittest.main()
