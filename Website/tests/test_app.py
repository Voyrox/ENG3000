"""
Tests for app.py, the PC-side broker and coordinator.

app.py is one module holding several concerns that only touch through global
state (`nodes`, `sync_tick`, `BROWSER_CONNECTIONS`, `WS_LOOP`). The tests below
are grouped by that concern, and `BrokerTestCase` resets the globals around
every test so nothing leaks between them:

  * FftFilter            - the ultrasonic low-pass, as a pure function
  * NodeRegistry         - id allocation, reuse and MAC de-duplication
  * Handshake            - the first line an ESP32 sends
  * ReadingPipeline      - median then FFT smoothing, and the rps meter
  * NodeLifecycle        - offline transitions and outbound control lines
  * CoordinatorTurns     - the collision-avoidance invariant that matters most
  * StaleNodeSweep       - the reaper thread
  * NodeConnection       - a whole TCP session against a fake socket
  * BrowserWebsocket     - /browser routing and the menu event
  * HttpApi              - the three Flask routes
  * BroadcastFanout      - how a worker thread reaches the browser

Nothing binds a real port and nothing sleeps for real, so the whole file runs
in well under a second:

    python -m unittest discover -s Website/tests
"""

import asyncio
import contextlib
import io
import json
import os
import sys
import threading
import time
import unittest
import warnings
from unittest import mock

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import app  # noqa: E402


class LoopStopped(Exception):
    """Raised by a stubbed `time.sleep` to break out of an infinite loop."""


def counting_sleep(ticks):
    """A `time.sleep` replacement that raises `LoopStopped` after `ticks` calls.

    `coordinator_loop` and `cleanup_stale_nodes` are `while True` around a
    sleep. Stubbing the sleep makes one iteration cost nothing and gives the
    test a deterministic exit instead of a wall-clock deadline.
    """
    state = {"n": 0}

    def _sleep(_seconds):
        state["n"] += 1
        if state["n"] > ticks:
            raise LoopStopped
    return _sleep


class RecordingConn:
    """Stands in for a node's socket: records the control lines it is sent."""

    def __init__(self, on_send=None):
        self.sent = []
        self._on_send = on_send

    def sendall(self, data):
        self.sent.append(data.decode("utf-8"))
        if self._on_send is not None:
            self._on_send(self)


class FakeNodeSocket:
    """A connected TCP socket for `handle_node_connection`.

    `recv` consumes what it returns (as a real socket does) and `makefile`
    hands back a real file object, because the handler uses it as a context
    manager.
    """

    def __init__(self, handshake=b"", stream=(), fail_send=False,
                 timeout_after=None):
        self._buffer = bytearray(handshake)
        self._pos = 0
        self._stream = "".join(stream)
        self.sent = []
        self.closed = False
        self.timeouts = []
        self._fail_send = fail_send
        self._timeout_after = timeout_after

    def settimeout(self, value):
        self.timeouts.append(value)

    def recv(self, size):
        if self._timeout_after is not None and self._pos >= self._timeout_after:
            raise TimeoutError("handshake timed out")
        chunk = bytes(self._buffer[self._pos:self._pos + size])
        self._pos += len(chunk)
        return chunk

    def sendall(self, data):
        if self._fail_send:
            raise OSError("connection reset by peer")
        self.sent.append(data.decode("utf-8"))

    def makefile(self, mode):
        return io.StringIO(self._stream)

    def close(self):
        self.closed = True


class FakeBrowserSocket:
    """The slice of a `websockets` connection that `browser_handler` uses."""

    def __init__(self, path="/browser", incoming=()):
        self.request = type("Request", (), {"path": path})()
        self.sent = []
        self.closed = False
        self._incoming = list(incoming)

    async def send(self, message):
        self.sent.append(message)

    async def close(self):
        self.closed = True

    def __aiter__(self):
        async def gen():
            for message in self._incoming:
                yield message
        return gen()

    def json_sent(self):
        return [json.loads(m) for m in self.sent]


class BrokerTestCase(unittest.TestCase):
    """Base case that isolates app.py's module-level broker state.

    app.py narrates every connection, tick and timeout to stdout for the
    operator's terminal. Under the test runner that is noise, so it is
    swallowed here and left alone everywhere else.
    """

    def setUp(self):
        self._saved = (dict(app.nodes), app.next_node_id, app.sync_tick,
                       set(app.BROWSER_CONNECTIONS), app.WS_LOOP)
        app.nodes.clear()
        app.next_node_id = 1
        app.sync_tick = 0
        app.BROWSER_CONNECTIONS.clear()
        app.WS_LOOP = None          # keeps schedule_broadcast_nodes inert
        self._quiet = contextlib.redirect_stdout(io.StringIO())
        self._quiet.__enter__()

    def tearDown(self):
        self._quiet.__exit__(None, None, None)
        nodes, next_id, tick, browsers, loop = self._saved
        app.nodes.clear()
        app.nodes.update(nodes)
        app.next_node_id = next_id
        app.sync_tick = tick
        app.BROWSER_CONNECTIONS.clear()
        app.BROWSER_CONNECTIONS.update(browsers)
        app.WS_LOOP = loop

    def add_node(self, address=("10.0.0.1", 1000), device_id=None, conn=None):
        """Register a node through the real path, optionally with a live conn."""
        node_id, _ = app.reuse_or_register_node(address, None, device_id)
        node = app.nodes[node_id]
        if conn is not None:
            node["conn"] = conn
        return node_id, node

    def run_loop_until(self, target, ticks):
        """Run an app.py `while True` worker for `ticks` iterations."""
        with mock.patch.object(app.time, "sleep", counting_sleep(ticks)):
            with self.assertRaises(LoopStopped):
                target()

    def start_event_loop(self):
        """Run an asyncio loop on a background thread, torn down on exit."""
        loop = asyncio.new_event_loop()
        thread = threading.Thread(
            target=lambda: (asyncio.set_event_loop(loop), loop.run_forever()),
            daemon=True)
        thread.start()

        def shutdown():
            loop.call_soon_threadsafe(loop.stop)
            thread.join(timeout=5)
            loop.close()

        self.addCleanup(shutdown)

        deadline = time.monotonic() + 2
        while not loop.is_running() and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertTrue(loop.is_running(), "the background loop never started")
        return loop


class FftFilterTests(unittest.TestCase):
    """`fft_filter_ultrasonic` is a pure function, so it is tested as one."""

    RATE = app.DISTANCE_SAMPLE_RATE_HZ

    def tone(self, hz, n=app.FFT_WINDOW, mean=10.0, amplitude=2.0):
        t = np.arange(n) / self.RATE
        return list(mean + amplitude * np.sin(2 * np.pi * hz * t))

    def span(self, values):
        return max(values) - min(values)

    def test_a_flat_signal_survives_untouched(self):
        readings = [5.0] * app.FFT_WINDOW
        self.assertTrue(np.allclose(app.fft_filter_ultrasonic(readings, self.RATE,
                                                             app.DISTANCE_CUTOFF_HZ),
                                    5.0))

    def test_a_constant_dc_offset_is_restored_after_filtering(self):
        # The mean is removed before the FFT and added back after, so a sensor
        # mounted with a large standing offset must not sag towards zero.
        readings = [137.0] * app.FFT_WINDOW
        filtered = app.fft_filter_ultrasonic(readings, self.RATE, app.DISTANCE_CUTOFF_HZ)
        self.assertTrue(np.allclose(filtered, 137.0))

    def test_a_tone_under_the_cutoff_keeps_its_amplitude(self):
        for hz in (0.5, 1.0):
            with self.subTest(hz=hz):
                readings = self.tone(hz)
                filtered = app.fft_filter_ultrasonic(readings, self.RATE,
                                                     app.DISTANCE_CUTOFF_HZ)
                self.assertGreater(self.span(filtered), 3.5,
                                   f"{hz} Hz should pass a {app.DISTANCE_CUTOFF_HZ} Hz cut")

    def test_a_tone_above_the_cutoff_is_flattened_towards_the_mean(self):
        # 64 samples at 20 Hz is a short window, so a brick-wall cut rings at
        # the edges; the swing has to collapse, not vanish exactly.
        for hz in (3.0, 5.0, 8.0):
            with self.subTest(hz=hz):
                readings = self.tone(hz)
                filtered = app.fft_filter_ultrasonic(readings, self.RATE,
                                                     app.DISTANCE_CUTOFF_HZ)
                self.assertLess(self.span(filtered), self.span(readings) / 2,
                                f"{hz} Hz should be mostly rejected")
                self.assertAlmostEqual(float(np.mean(filtered)), 10.0, delta=0.5)

    def test_cutting_higher_rejects_more_than_cutting_lower(self):
        readings = self.tone(8.0)
        low = app.fft_filter_ultrasonic(readings, self.RATE, 2.0)
        high = app.fft_filter_ultrasonic(readings, self.RATE, 9.0)
        self.assertLess(self.span(low), self.span(high))

    def test_length_is_preserved(self):
        for n in (1, 2, app.FFT_MIN_SAMPLES, app.FFT_WINDOW):
            with self.subTest(n=n):
                filtered = app.fft_filter_ultrasonic(self.tone(4.0, n=n),
                                                     self.RATE, app.DISTANCE_CUTOFF_HZ)
                self.assertEqual(len(filtered), n)

    def test_a_single_sample_is_returned_unchanged(self):
        self.assertTrue(np.allclose(app.fft_filter_ultrasonic([7.0], self.RATE, 2.0), [7.0]))

    def test_no_readings_is_a_caller_error_not_a_crash(self):
        # Nothing in app.py can reach this - `update_distance` gates on
        # FFT_MIN_SAMPLES first - but numpy would otherwise raise deep inside
        # rfftfreq, so the contract is pinned here.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            with self.assertRaises(ValueError):
                app.fft_filter_ultrasonic([], self.RATE, 2.0)


class NodeRegistryTests(BrokerTestCase):

    def test_ids_are_handed_out_in_order(self):
        first, _ = app.reuse_or_register_node(("1.1.1.1", 1), None)
        second, _ = app.reuse_or_register_node(("2.2.2.2", 2), None)
        self.assertEqual([first, second], [1, 2])

    def test_a_fresh_node_starts_online_and_unsynced(self):
        _, node = self.add_node(device_id="AA:BB")
        self.assertTrue(node["online"])
        self.assertFalse(node["synced"])
        self.assertFalse(node["has_turn"])
        self.assertIsNone(node["filtered_distance"])
        self.assertIsNone(node["latest"])

    def test_the_address_is_recorded_as_host_and_port(self):
        _, node = self.add_node(address=("192.168.1.42", 12345))
        self.assertEqual(node["address"], "192.168.1.42:12345")

    def test_reclaiming_a_known_id_keeps_the_id_and_clears_the_run(self):
        node_id, node = self.add_node(conn=RecordingConn())
        node["synced"] = True
        node["has_turn"] = True
        node["filtered_distance"] = 12.0
        node["rps"] = 9.0
        app.update_node(node_id, '{"avg":20}')

        again, reused = app.reuse_or_register_node(("9.9.9.9", 1), node_id)

        self.assertEqual(again, node_id)
        self.assertTrue(reused)
        self.assertEqual(len(app.nodes), 1, "a reconnect must not duplicate the node")
        self.assertEqual(node["address"], "9.9.9.9:1")
        self.assertEqual(node["rps"], 0.0, "the old rate window must not survive")
        self.assertIsNone(node["filtered_distance"], "history must restart")
        self.assertIsNone(node["conn"])
        self.assertFalse(node["synced"])
        self.assertFalse(node["has_turn"])
        self.assertEqual(len(node["distance_samples"]), 0)

    def test_a_known_mac_wins_over_an_unclaimed_id(self):
        """A rebooted ESP32 forgets its node id but keeps its MAC."""
        node_id, node = self.add_node(device_id="AA:BB")
        again, reused = app.reuse_or_register_node(("9.9.9.9", 1), 4242, "AA:BB")
        self.assertEqual(again, node_id)
        self.assertTrue(reused)

    def test_a_new_mac_registers_a_second_node(self):
        """Different hardware, different node - they both stay on the board."""
        first, _ = self.add_node(device_id="AA:BB")
        second, reused = app.reuse_or_register_node(("2.2.2.2", 2), None, "CC:DD")
        self.assertFalse(reused)
        self.assertEqual(sorted(app.nodes), [first, second])
        self.assertEqual(app.nodes[first]["device_id"], "AA:BB")
        self.assertEqual(app.nodes[second]["device_id"], "CC:DD")

    def test_find_known_node_prefers_the_mac_match(self):
        node_id, _ = self.add_node(device_id="AA:BB")
        self.add_node(address=("2.2.2.2", 2), device_id="CC:DD")
        found = app.find_known_node(node_id, "CC:DD")
        self.assertEqual(found["device_id"], "CC:DD")

    def test_find_known_node_falls_back_to_the_claimed_id(self):
        node_id, _ = self.add_node()
        self.assertIs(app.find_known_node(node_id, None), app.nodes[node_id])

    def test_find_known_node_gives_up_on_an_unknown_id(self):
        self.assertIsNone(app.find_known_node(99, None))
        self.assertIsNone(app.find_known_node(None, "nope"))

    def test_a_second_node_claiming_the_same_mac_evicts_the_first(self):
        """MAC is the hardware identity; two records for it would double-count."""
        first, _ = self.add_node(address=("1.1.1.1", 1), device_id="AA:BB")
        second, _ = self.add_node(address=("2.2.2.2", 2), device_id="CC:DD")

        app.update_node(second, json.dumps({"avg": 10, "mac": "AA:BB"}))

        self.assertNotIn(first, app.nodes)
        self.assertEqual(app.nodes[second]["device_id"], "AA:BB")

    def test_a_macs_own_node_is_never_evicted_by_itself(self):
        node_id, _ = self.add_node(device_id="AA:BB")
        app.update_node(node_id, json.dumps({"avg": 10, "mac": "AA:BB"}))
        self.assertEqual(list(app.nodes), [node_id])

    def test_snapshot_is_json_serialisable_and_sorted_by_id(self):
        self.add_node(address=("2.2.2.2", 2))
        self.add_node(address=("1.1.1.1", 1))
        snapshot = app.snapshot_nodes()
        self.assertEqual([n["id"] for n in snapshot], [1, 2])
        json.dumps(snapshot)

    def test_the_snapshot_never_leaks_the_mac(self):
        """serialize_node is the browser-facing shape; the MAC stays server-side."""
        _, node = self.add_node(device_id="AA:BB")
        self.assertNotIn("device_id", app.serialize_node(node))

    def test_the_snapshot_exposes_the_fields_the_dashboard_reads(self):
        node_id, _ = self.add_node()
        app.update_node(node_id, '{"avg":12.5}')
        fields = set(app.serialize_node(app.nodes[node_id]))
        self.assertEqual(fields, {"id", "address", "latest", "filtered_distance",
                                  "online", "last_seen", "rps", "synced", "has_turn"})


class HandshakeTests(BrokerTestCase):
    """The first line a node sends: a bare id, or a JSON reading with a MAC."""

    def read(self, raw, **kwargs):
        return app.read_handshake_line(FakeNodeSocket(raw, **kwargs))

    def test_a_bare_number_is_read_as_the_claimed_id(self):
        self.assertEqual(app.parse_handshake("3"), (3, None))

    def test_trailing_carriage_return_is_stripped(self):
        self.assertEqual(self.read(b"7\r\n"), "7")
        self.assertEqual(app.parse_handshake("7"), (7, None))

    def test_reading_stops_at_the_first_newline(self):
        self.assertEqual(self.read(b'{"avg":5}\n{"avg":6}\n'), '{"avg":5}')

    def test_a_read_timeout_yields_the_bytes_so_far(self):
        # recv() raising TimeoutError must not lose a partial handshake.
        conn = FakeNodeSocket(b"42", timeout_after=2)
        self.assertEqual(app.read_handshake_line(conn), "42")

    def test_a_read_timeout_before_any_byte_reads_as_empty(self):
        self.assertEqual(app.read_handshake_line(FakeNodeSocket(b"", timeout_after=0)), "")

    def test_a_closed_socket_reads_as_empty(self):
        self.assertEqual(self.read(b""), "")

    def test_an_over_long_handshake_is_truncated(self):
        """HANDSHAKE_READ_LIMIT is a slowloris guard, so it must actually bite."""
        raw = b"x" * (app.HANDSHAKE_READ_LIMIT + 50) + b"\n"
        self.assertEqual(len(self.read(raw)), app.HANDSHAKE_READ_LIMIT)

    def test_json_handshake_yields_both_the_id_and_the_mac(self):
        parsed = app.parse_handshake('{"nodeId":4,"mac":"AA:BB"}')
        self.assertEqual(parsed, (4, "AA:BB"))

    def test_json_without_a_node_id_yields_only_the_mac(self):
        self.assertEqual(app.parse_handshake('{"mac":"AA:BB"}'), (None, "AA:BB"))

    def test_a_negative_id_is_refused(self):
        """A node must never be able to claim -1 and index backwards."""
        self.assertEqual(app.parse_handshake("-3"), (None, None))
        self.assertEqual(app.parse_handshake('{"nodeId":-3,"mac":"AA"}'), (None, "AA"))

    def test_unparseable_input_yields_nothing_at_all(self):
        self.assertEqual(app.parse_handshake("garbage"), (None, None))
        self.assertEqual(app.parse_handshake(""), (None, None))

    def test_parse_message_swallows_broken_json(self):
        self.assertEqual(app.parse_message("{not json"), {})


class ReadingPipelineTests(BrokerTestCase):
    """Every node message is median-smoothed, then low-pass filtered."""

    def feed(self, node_id, values, key="avg"):
        for value in values:
            app.update_node(node_id, json.dumps({key: value}))

    def test_the_first_reading_becomes_the_distance(self):
        node_id, node = self.add_node()
        app.update_node(node_id, '{"avg":42}')
        self.assertEqual(node["filtered_distance"], 42.0)

    def test_distance_wins_over_avg(self):
        node_id, node = self.add_node()
        app.update_node(node_id, '{"avg":1,"distance":42}')
        self.assertEqual(node["filtered_distance"], 42.0)

    def test_avg_is_the_fallback_when_distance_is_absent(self):
        node_id, node = self.add_node()
        app.update_node(node_id, '{"avg":7}')
        self.assertEqual(node["filtered_distance"], 7.0)

    def test_a_null_distance_falls_back_to_avg(self):
        node_id, node = self.add_node()
        app.update_node(node_id, '{"distance":null,"avg":7}')
        self.assertEqual(node["filtered_distance"], 7.0)

    def test_a_numeric_string_is_accepted(self):
        node_id, node = self.add_node()
        app.update_node(node_id, '{"avg":"3.5"}')
        self.assertEqual(node["filtered_distance"], 3.5)

    def test_a_message_with_no_distance_leaves_the_last_one_alone(self):
        node_id, node = self.add_node()
        app.update_node(node_id, '{"avg":7}')
        for bad in ('{"avg":"nonsense"}', '{"other":1}', '{"avg":null}', "{not json"):
            with self.subTest(bad=bad):
                app.update_node(node_id, bad)
                self.assertEqual(node["filtered_distance"], 7.0)
                self.assertEqual(node["latest"], bad, "the raw line is still published")

    def test_a_single_spike_inside_the_window_cannot_move_the_median(self):
        node_id, node = self.add_node()
        self.feed(node_id, [10, 10, 10, 10, 90])
        self.assertEqual(node["filtered_distance"], 10.0)

    def test_both_smoothing_windows_are_bounded(self):
        """Unbounded history would make the reading rate decide the answer."""
        node_id, node = self.add_node()
        self.feed(node_id, range(app.FFT_WINDOW + 50))
        self.assertEqual(len(node["median_samples"]), app.MEDIAN_WINDOW)
        self.assertEqual(len(node["distance_samples"]), app.FFT_WINDOW)

    def test_below_the_minimum_the_median_is_published_verbatim(self):
        """Before the FFT warms up the raw median must not be smoothed twice."""
        node_id, node = self.add_node()
        alternating = [10 if i % 2 == 0 else 90 for i in range(app.FFT_MIN_SAMPLES - 1)]
        self.feed(node_id, alternating)

        self.assertEqual(len(node["distance_samples"]), app.FFT_MIN_SAMPLES - 1)
        self.assertEqual(node["filtered_distance"], float(np.median(node["median_samples"])))
        self.assertEqual(node["filtered_distance"], 10.0)

    def test_the_fft_takes_over_at_exactly_the_minimum_sample_count(self):
        node_id, node = self.add_node()
        alternating = [10 if i % 2 == 0 else 90 for i in range(app.FFT_MIN_SAMPLES)]
        self.feed(node_id, alternating)

        self.assertEqual(len(node["distance_samples"]), app.FFT_MIN_SAMPLES)
        # The FFT strips the alternating component and restores the window
        # mean, so the published value jumps well away from the median.
        self.assertNotAlmostEqual(node["filtered_distance"], 10.0, places=1)

    def test_the_filter_output_is_always_a_plain_float(self):
        node_id, node = self.add_node()
        self.feed(node_id, [float(i % 17) for i in range(app.FFT_WINDOW)])
        self.assertIsInstance(node["filtered_distance"], float)
        json.dumps(app.serialize_node(node))

    def test_the_rps_meter_counts_the_last_second(self):
        node_id, node = self.add_node()
        with mock.patch.object(app.time, "monotonic", side_effect=[0.0, 0.1, 0.2]):
            app.update_rate(node, 0.0)
            app.update_rate(node, 0.1)
            app.update_rate(node, 0.2)
        self.assertAlmostEqual(node["rps"], 3.0)

    def test_readings_older_than_the_window_fall_out_of_the_rate(self):
        node_id, node = self.add_node()
        app.update_rate(node, 100.0)
        app.update_rate(node, 100.5)
        self.assertAlmostEqual(node["rps"], 2.0)

        app.update_rate(node, 100.5 + app.RPS_WINDOW_SECONDS + 0.1)
        self.assertAlmostEqual(node["rps"], 1.0, msg="only the fresh sample remains")

    def test_a_message_refreshes_liveness_and_keeps_the_raw_line(self):
        node_id, node = self.add_node()
        node["online"] = False
        app.update_node(node_id, '{"avg":1,"extra":"kept"}')
        self.assertTrue(node["online"])
        self.assertEqual(node["latest"], '{"avg":1,"extra":"kept"}')

    def test_a_message_for_an_unknown_node_is_ignored(self):
        self.add_node()
        app.update_node(9999, '{"avg":1}')
        self.assertEqual(len(app.nodes), 1)


class NodeLifecycleTests(BrokerTestCase):

    def test_going_offline_clears_the_rate_and_the_turn(self):
        node_id, node = self.add_node(conn=RecordingConn())
        app.update_node(node_id, '{"avg":1}')
        node["synced"] = True
        node["has_turn"] = True

        app.mark_node_offline(node_id)

        self.assertFalse(node["online"])
        self.assertEqual(node["rps"], 0.0)
        self.assertEqual(len(node["samples"]), 0)
        self.assertFalse(node["synced"])
        self.assertFalse(node["has_turn"])
        self.assertIsNone(node["conn"])

    def test_marking_an_unknown_node_offline_is_a_no_op(self):
        self.add_node()
        app.mark_node_offline(9999)

    def test_a_turn_grant_and_revoke_are_both_sent_on_the_wire(self):
        _, node = self.add_node(conn=RecordingConn())
        app.set_turn(node["id"], True)
        self.assertTrue(node["has_turn"])
        app.set_turn(node["id"], False)
        self.assertFalse(node["has_turn"])
        self.assertEqual(node["conn"].sent, ["TURN\n", "HALT\n"])

    def test_control_lines_end_with_a_single_newline(self):
        """The firmware splits commands on '\\n' and trims, so CRLF is noise."""
        _, node = self.add_node(conn=RecordingConn())
        app.set_turn(node["id"], True)
        for line in node["conn"].sent:
            self.assertFalse(line.endswith("\r"))
            self.assertTrue(line.endswith("\n"))
            self.assertEqual(line.count("\n"), 1)

    def test_syncing_sends_the_authoritative_tick(self):
        app.sync_tick = 12
        _, node = self.add_node(conn=RecordingConn())
        app.sync_node(node["id"])
        self.assertTrue(node["synced"])
        self.assertEqual(node["conn"].sent, ["SYNC 12\n"])

    def test_commands_for_an_unknown_node_are_dropped(self):
        app.send_command(9999, "PING")
        app.sync_node(9999)
        app.set_turn(9999, True)
        self.assertEqual(list(app.nodes), [])

    def test_a_command_to_a_disconnected_node_is_dropped(self):
        node_id, _ = self.add_node()          # conn is None
        app.send_command(node_id, "PING")     # must not raise

    def test_a_dropped_connection_does_not_break_the_coordinator(self):
        node_id, node = self.add_node()

        class BrokenConn(RecordingConn):
            def sendall(self, data):
                raise OSError("connection reset by peer")

        node["conn"] = BrokenConn()
        app.send_command(node_id, "PING")
        app.sync_node(node_id)
        app.set_turn(node_id, True)
        self.assertTrue(node["has_turn"], "the broker keeps its own state")

    def test_commands_to_one_node_are_never_interleaved(self):
        """The conn lock is the only thing standing between two threads and a
        spliced command line, so it has to cover the whole write."""
        trace = []

        def on_send(_conn):
            trace.append("in")
            time.sleep(0.002)
            trace.append("out")

        node_id, node = self.add_node(conn=RecordingConn(on_send=on_send))

        threads = [threading.Thread(target=app.send_command, args=(node_id, f"TICK {i}"))
                   for i in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(len(node["conn"].sent), 4)
        self.assertEqual(trace, ["in", "out"] * 4, "a write was spliced")


class CoordinatorTurnsTests(BrokerTestCase):
    """The PC is the source of truth: exactly one node may scan at a time.

    Two ultrasonic sensors firing together cross-talk, so exclusivity is the
    safety property this whole broker exists to provide.
    """

    def tick(self, ticks):
        self.run_loop_until(app.coordinator_loop, ticks)

    def online_nodes(self):
        return self.add_nodes(3)

    def add_nodes(self, count):
        ids = []
        for index in range(count):
            node_id, _ = self.add_node(address=(f"10.0.0.{index + 1}", 1000 + index),
                                      conn=RecordingConn())
            ids.append(node_id)
        return ids

    def test_exactly_one_node_holds_the_turn_after_a_tick(self):
        ids = self.online_nodes()
        self.tick(1)
        holders = [n for n in app.nodes.values() if n["has_turn"]]
        self.assertEqual(len(holders), 1)
        self.assertIn(holders[0]["id"], ids)

    def test_the_tick_count_advances_once_per_round(self):
        self.online_nodes()
        self.tick(3)
        self.assertEqual(app.sync_tick, 3)

    def test_the_turn_goes_to_every_node_before_repeating(self):
        """Otherwise one sensor starves and its column goes stale for ever."""
        ids = self.online_nodes()

        holders = []
        for _ in range(len(ids)):
            self.tick(1)
            holders.append(next(n["id"] for n in app.nodes.values() if n["has_turn"]))

        self.assertEqual(sorted(holders), sorted(ids), "a node never got a turn")

    def test_exactly_one_holder_after_every_single_tick(self):
        ids = self.online_nodes()
        for tick in range(1, len(ids) + 2):
            self.tick(1)
            holders = [n["id"] for n in app.nodes.values() if n["has_turn"]]
            self.assertEqual(len(holders), 1, f"{len(holders)} nodes scanning at tick {tick}")
            self.assertIn(holders[0], ids)

    def test_every_node_is_synced_before_any_is_granted_a_turn(self):
        """sync.cpp refuses to scan until it has a tick, so each node's SYNC
        for the round must precede the TURN or HALT that follows it."""
        ids = self.online_nodes()
        self.tick(1)
        for node_id in ids:
            commands = app.nodes[node_id]["conn"].sent
            self.assertEqual(commands[0], "SYNC 1\n")
            self.assertIn(commands[1], ("TURN\n", "HALT\n"))
            self.assertTrue(app.nodes[node_id]["synced"])

    def test_a_turn_only_follows_a_sync_on_the_same_socket(self):
        ids = self.online_nodes()
        self.tick(1)
        for node_id in ids:
            commands = app.nodes[node_id]["conn"].sent
            if "TURN\n" in commands:
                self.assertLess(commands.index("SYNC 1\n"), commands.index("TURN\n"))

    def test_every_node_is_synced_with_the_same_tick(self):
        """The tick is the shared clock; the nodes must never disagree on it."""
        ids = self.online_nodes()
        self.tick(2)
        for node_id in ids:
            syncs = [c for c in app.nodes[node_id]["conn"].sent if c.startswith("SYNC")]
            self.assertEqual(syncs, ["SYNC 1\n", "SYNC 2\n"])

    def test_a_halted_node_is_told_halt_not_turn(self):
        ids = self.online_nodes()
        self.tick(1)
        holder = next(n for n in app.nodes.values() if n["has_turn"])
        others = [app.nodes[i] for i in ids if i != holder["id"]]

        for node in others:
            self.assertFalse(node["has_turn"])
            self.assertIn("HALT\n", node["conn"].sent)
            self.assertNotIn("TURN\n", node["conn"].sent)
        self.assertIn("TURN\n", holder["conn"].sent)

    def test_a_node_with_no_connection_is_never_given_a_turn(self):
        """Coordinator authority is only meaningful over a live socket, and a
        lone survivor keeps the slot rather than being skipped."""
        connected, _ = self.add_node(address=("10.0.0.1", 1), conn=RecordingConn())
        stranded, _ = self.add_node(address=("10.0.0.2", 2))     # conn is None
        self.tick(2)

        self.assertTrue(app.nodes[connected]["has_turn"])
        self.assertEqual(app.nodes[connected]["conn"].sent,
                         ["SYNC 1\n", "TURN\n", "SYNC 2\n", "TURN\n"])
        self.assertFalse(app.nodes[stranded]["has_turn"])
        self.assertIsNone(app.nodes[stranded]["conn"])
        self.assertEqual(app.sync_tick, 2, "ticks still advance with no one to scan")

    def test_a_node_that_drops_offline_stops_scanning(self):
        ids = self.online_nodes()
        self.tick(2)

        app.mark_node_offline(ids[0])
        self.tick(1)

        self.assertFalse(app.nodes[ids[0]]["has_turn"])
        holders = [n["id"] for n in app.nodes.values() if n["has_turn"]]
        self.assertTrue(holders and ids[0] not in holders,
                        "the departed node was handed the slot again")

    def test_the_coordinator_idles_when_nothing_is_connected(self):
        self.tick(2)
        self.assertEqual(app.sync_tick, 2)
        self.assertEqual(app.nodes, {})


class StaleNodeSweepTests(BrokerTestCase):
    """`cleanup_stale_nodes` is the backstop for a node that vanishes."""

    def test_a_silent_node_is_marked_offline_and_stops_counting(self):
        node_id, node = self.add_node()
        app.update_rate(node, time.monotonic())
        self.assertGreater(node["rps"], 0.0)
        node["last_seen"] = time.monotonic() - (app.NODE_STALE_SECONDS + 1)

        self.run_loop_until(app.cleanup_stale_nodes, 1)

        self.assertFalse(node["online"])
        self.assertEqual(node["rps"], 0.0, "a departed node cannot report a rate")
        self.assertEqual(len(node["samples"]), 0)

    def test_a_recently_seen_node_is_left_alone(self):
        node_id, node = self.add_node()
        self.run_loop_until(app.cleanup_stale_nodes, 3)
        self.assertTrue(node["online"])

    def test_a_node_already_offline_is_not_touched(self):
        _, node = self.add_node()
        node["online"] = False
        node["last_seen"] = time.monotonic() - (app.NODE_STALE_SECONDS + 1)
        self.run_loop_until(app.cleanup_stale_nodes, 1)
        self.assertFalse(node["online"])

    def test_a_sweep_does_not_rewrite_the_last_seen_clock(self):
        _, node = self.add_node()
        node["last_seen"] = time.monotonic() - (app.NODE_STALE_SECONDS + 1)
        stamp = node["last_seen"]
        self.run_loop_until(app.cleanup_stale_nodes, 2)
        self.assertEqual(node["last_seen"], stamp)

    def test_the_threshold_is_the_documented_one(self):
        """A node must survive a single dropped packet but not a real outage."""
        _, node = self.add_node()
        node["last_seen"] = time.monotonic() - (app.NODE_STALE_SECONDS - 1)
        self.run_loop_until(app.cleanup_stale_nodes, 1)
        self.assertTrue(node["online"], "just inside the window, still online")

        node["last_seen"] = time.monotonic() - (app.NODE_STALE_SECONDS + 1)
        self.run_loop_until(app.cleanup_stale_nodes, 1)
        self.assertFalse(node["online"])

    def test_an_offline_node_is_never_deleted(self):
        """The dashboard shows departed nodes; only id reuse removes them."""
        node_id, node = self.add_node()
        node["last_seen"] = time.monotonic() - (app.NODE_STALE_SECONDS + 1)
        self.run_loop_until(app.cleanup_stale_nodes, 2)
        self.assertIn(node_id, app.nodes)


class NodeConnectionTests(BrokerTestCase):
    """A whole TCP session, driven through a fake socket."""

    def connect(self, handshake, stream=(), address=("10.0.0.1", 1000), **kwargs):
        conn = FakeNodeSocket(handshake, stream, **kwargs)
        app.handle_node_connection(conn, address)
        return conn

    def test_the_assigned_id_is_sent_on_the_first_line(self):
        conn = self.connect(b"\r\n")
        self.assertEqual(conn.sent, ["1\n"])
        self.assertEqual(list(app.nodes), [1])

    def test_the_socket_is_told_to_block_while_the_handshake_arrives(self):
        conn = self.connect(b"\r\n")
        self.assertEqual(conn.timeouts[0], app.HANDSHAKE_TIMEOUT_SECONDS)
        self.assertIsNone(conn.timeouts[1], "the read timeout must be lifted")

    def test_a_reconnecting_node_gets_its_old_id_back(self):
        self.connect(b'\r\n', ['{"mac":"AA:BB","avg":1}\n'], ("10.0.0.1", 1))
        conn = self.connect(b'{"nodeId":1,"mac":"AA:BB"}\r\n', [], ("10.0.0.9", 2))
        self.assertEqual(conn.sent, ["1\n"])
        self.assertEqual(len(app.nodes), 1)
        self.assertEqual(app.nodes[1]["address"], "10.0.0.9:2")

    def test_an_unknown_claimed_id_gets_a_fresh_one(self):
        self.connect(b"77\r\n", [], ("10.0.0.1", 1))
        self.assertEqual(list(app.nodes), [1])

    def test_a_bare_id_handshake_publishes_nothing(self):
        self.connect(b"7\r\n", ['{"avg":11}\n'], ("10.0.0.1", 1))
        self.assertEqual(app.nodes[1]["latest"], '{"avg":11}')

    def test_a_json_handshake_is_the_first_reading_too(self):
        """The MAC and the first distance arrive in the same line."""
        self.connect(b'{"nodeId":0,"mac":"AA:BB","avg":30}\r\n', [], ("10.0.0.1", 1))
        node = app.nodes[1]
        self.assertEqual(node["device_id"], "AA:BB")
        self.assertEqual(node["filtered_distance"], 30.0)

    def test_an_unparseable_handshake_is_still_ingested(self):
        self.connect(b"garbage\r\n", [], ("10.0.0.1", 1))
        self.assertEqual(app.nodes[1]["latest"], "garbage")

    def test_the_stream_is_consumed_line_by_line(self):
        self.connect(b"\r\n", ['{"avg":1}\n', '\n', '   \n', '{"avg":2}\n'], ("10.0.0.1", 1))
        self.assertEqual(app.nodes[1]["latest"], '{"avg":2}')

    def test_the_node_is_marked_offline_and_the_socket_closed_on_exit(self):
        conn = self.connect(b"\r\n", ['{"avg":1}\n'], ("10.0.0.1", 1))
        self.assertFalse(app.nodes[1]["online"])
        self.assertTrue(conn.closed)

    def test_a_handshake_timeout_still_registers_a_node(self):
        """The ESP32 boots slowly; a silent handshake must not lose the slot."""
        self.connect(b"", [], ("10.0.0.1", 1), timeout_after=0)
        self.assertEqual(list(app.nodes), [1])
        self.assertFalse(app.nodes[1]["online"])

    def test_a_reset_socket_is_reported_not_raised(self):
        self.connect(b"\r\n", [], ("10.0.0.1", 1), fail_send=True)
        self.assertFalse(app.nodes[1]["online"])

    def test_the_session_keeps_the_conn_lock_per_node(self):
        self.connect(b"\r\n", ['{"avg":1}\n'], ("10.0.0.1", 1))
        self.assertIsInstance(app.nodes[1]["conn_lock"], type(threading.Lock()))

    def test_two_nodes_talk_at_once(self):
        self.connect(b"\r\n", ['{"mac":"AA","avg":1}\n'], ("10.0.0.1", 1))
        self.connect(b"\r\n", ['{"mac":"BB","avg":2}\n'], ("10.0.0.2", 2))
        self.assertEqual(sorted(app.nodes), [1, 2])
        self.assertEqual([n["filtered_distance"] for n in app.nodes.values()], [1.0, 2.0])


class BrowserWebsocketTests(BrokerTestCase):
    """The dashboard connects to /browser; anything else is turned away."""

    def run_handler(self, websocket):
        return asyncio.run(app.websocket_handler(websocket))

    def test_an_unknown_path_is_closed(self):
        websocket = FakeBrowserSocket("/nope")
        self.run_handler(websocket)
        self.assertTrue(websocket.closed)
        self.assertEqual(websocket.sent, [])

    def test_a_new_browser_is_given_the_current_state_immediately(self):
        self.add_node(address=("10.0.0.1", 1))
        websocket = FakeBrowserSocket("/browser")
        self.run_handler(websocket)

        first = websocket.json_sent()[0]
        self.assertEqual(first["type"], "nodes:update")
        self.assertEqual([n["id"] for n in first["nodes"]], [1])

    def test_the_connection_is_tracked_while_open_and_dropped_after(self):
        websocket = FakeBrowserSocket("/browser")
        app.BROWSER_CONNECTIONS.add(websocket)
        self.run_handler(websocket)
        self.assertNotIn(websocket, app.BROWSER_CONNECTIONS)

    def test_a_malformed_frame_is_ignored(self):
        websocket = FakeBrowserSocket("/browser", ["{not json", "also not json"])
        self.run_handler(websocket)
        self.assertEqual(len(websocket.sent), 1, "only the initial snapshot")

    def test_a_menu_selection_is_echoed_to_every_browser(self):
        with mock.patch.object(app, "broadcast", autospec=True) as broadcast:
            websocket = FakeBrowserSocket(
                "/browser", [json.dumps({"type": "menu:select", "option": "Start"})])
            self.run_handler(websocket)

        broadcast.assert_called_once()
        connections, payload = broadcast.call_args.args
        status = json.loads(payload)
        self.assertEqual(status["type"], "menu:status")
        self.assertIn("Start", status["message"])
        self.assertIn(websocket, list(connections))

    def test_an_unknown_event_type_is_ignored(self):
        with mock.patch.object(app, "broadcast", autospec=True) as broadcast:
            websocket = FakeBrowserSocket("/browser", [json.dumps({"type": "nope"})])
            self.run_handler(websocket)
        broadcast.assert_not_called()

    def test_a_menu_selection_without_an_option_still_answers(self):
        with mock.patch.object(app, "broadcast", autospec=True) as broadcast:
            websocket = FakeBrowserSocket("/browser", [json.dumps({"type": "menu:select"})])
            self.run_handler(websocket)
        self.assertIn("unknown", json.loads(broadcast.call_args.args[1])["message"])

    def test_the_browser_never_receives_the_nodes_mac(self):
        self.add_node(device_id="AA:BB")
        websocket = FakeBrowserSocket("/browser")
        self.run_handler(websocket)
        self.assertNotIn("device_id", websocket.json_sent()[0]["nodes"][0])


class HttpApiTests(BrokerTestCase):

    def setUp(self):
        super().setUp()
        self.client = app.app.test_client()

    def test_the_dashboard_page_is_served(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/html", response.content_type)

    def test_the_node_list_is_json(self):
        self.add_node(address=("10.0.0.1", 1))
        response = self.client.get("/api/nodes")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([n["id"] for n in response.get_json()], [1])

    def test_an_empty_broker_returns_an_empty_list_not_an_error(self):
        response = self.client.get("/api/nodes")
        self.assertEqual(response.get_json(), [])

    def test_one_node_is_returned_on_its_own(self):
        node_id, _ = self.add_node()
        app.update_node(node_id, '{"avg":12.5}')
        payload = self.client.get(f"/api/nodes/{node_id}").get_json()
        self.assertEqual(payload["id"], node_id)
        self.assertEqual(payload["filtered_distance"], 12.5)
        self.assertEqual(payload["latest"], '{"avg":12.5}')

    def test_an_unknown_node_is_a_404(self):
        response = self.client.get("/api/nodes/99")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json(), {"error": "unknown node"})

    def test_a_departed_node_is_still_readable(self):
        node_id, _ = self.add_node()
        app.mark_node_offline(node_id)
        response = self.client.get(f"/api/nodes/{node_id}")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()["online"])

    def test_the_api_agrees_with_the_websocket_payload(self):
        """The dashboard can be fed by either source, so they must not drift."""
        node_id, _ = self.add_node()
        app.update_node(node_id, '{"avg":9}')
        over_http = self.client.get("/api/nodes").get_json()
        websocket = FakeBrowserSocket("/browser")
        asyncio.run(app.websocket_handler(websocket))
        over_ws = websocket.json_sent()[0]["nodes"]
        for a, b in zip(over_http, over_ws):
            self.assertEqual(a["id"], b["id"])
            self.assertEqual(a["filtered_distance"], b["filtered_distance"])
            self.assertEqual(a["online"], b["online"])


class BroadcastFanoutTests(BrokerTestCase):
    """Node updates are raised on TCP threads but must be sent on the loop."""

    def test_no_browser_means_no_broadcast(self):
        app.BROWSER_CONNECTIONS.clear()
        with mock.patch.object(app, "broadcast", autospec=True) as broadcast:
            asyncio.run(app.broadcast_nodes())
        broadcast.assert_not_called()

    def test_the_payload_carries_the_serialised_nodes(self):
        websocket = FakeBrowserSocket("/browser")
        app.BROWSER_CONNECTIONS.add(websocket)
        with mock.patch.object(app, "broadcast", autospec=True) as broadcast:
            asyncio.run(app.broadcast_nodes())

        connections, payload = broadcast.call_args.args
        self.assertIn(websocket, list(connections))
        decoded = json.loads(payload)
        self.assertEqual(decoded["type"], "nodes:update")
        json.dumps(decoded)

    def test_the_connection_set_is_snapshotted_before_sending(self):
        """A browser closing mid-broadcast must not mutate the set being sent.

        `websockets.broadcast` iterates what it is handed, and a socket can
        disconnect from another thread while that loop is running, so the live
        set is copied first.
        """
        websocket = FakeBrowserSocket("/browser")
        app.BROWSER_CONNECTIONS.add(websocket)
        captured = {}

        def grab(connections, message):
            captured["connections"] = connections
            app.BROWSER_CONNECTIONS.clear()          # a browser drops mid-send

        with mock.patch.object(app, "broadcast", grab):
            asyncio.run(app.broadcast_nodes())

        self.assertIsNot(captured["connections"], app.BROWSER_CONNECTIONS)
        self.assertEqual(list(captured["connections"]), [websocket])

    def test_scheduling_is_a_no_op_without_a_running_loop(self):
        app.WS_LOOP = None
        with mock.patch.object(app, "broadcast", autospec=True) as broadcast:
            app.schedule_broadcast_nodes()          # must not raise
        broadcast.assert_not_called()

    def test_scheduling_is_a_no_op_when_the_loop_has_stopped(self):
        loop = asyncio.new_event_loop()
        loop.close()
        app.WS_LOOP = loop
        app.schedule_broadcast_nodes()              # must not raise

    def test_an_update_from_a_worker_thread_reaches_the_browser(self):
        """The TCP handler runs on its own thread, so this is the real path."""
        reached = threading.Event()
        seen = []
        loop = self.start_event_loop()

        app.WS_LOOP = loop
        app.BROWSER_CONNECTIONS.add(FakeBrowserSocket("/browser"))
        node_id, _ = self.add_node()

        def record(_connections, message):
            seen.append(message)
            reached.set()

        with mock.patch.object(app, "broadcast", record):
            app.schedule_broadcast_nodes()
            self.assertTrue(reached.wait(2), "the update never reached the loop")

        self.assertEqual(json.loads(seen[0])["type"], "nodes:update")
        self.assertEqual(node_id, 1)

    def test_a_worker_thread_update_is_a_safe_no_op_when_everyone_leaves(self):
        """BROWSER_CONNECTIONS can empty itself between scheduling and sending."""
        app.WS_LOOP = self.start_event_loop()
        app.BROWSER_CONNECTIONS.clear()
        with mock.patch.object(app, "broadcast", autospec=True) as broadcast:
            app.schedule_broadcast_nodes()
            time.sleep(0.05)             # let the scheduled coroutine finish
        broadcast.assert_not_called()


class NodeRoleTests(BrokerTestCase):
    """The calibration screen's LEFT / RIGHT reaches the scanner nodes."""

    def setUp(self):
        super().setUp()
        self._saved_roles = dict(app.node_roles)
        app.node_roles.clear()

    def tearDown(self):
        app.node_roles.clear()
        app.node_roles.update(self._saved_roles)
        super().tearDown()

    def test_the_assignment_sends_each_node_its_role(self):
        left_id, left = self.add_node(conn=RecordingConn())
        right_id, right = self.add_node(address=("10.0.0.2", 1001), conn=RecordingConn())
        app.assign_node_roles([left_id, None, right_id])
        self.assertEqual(left["conn"].sent, ["ROLE LEFT\n"])
        self.assertEqual(right["conn"].sent, ["ROLE RIGHT\n"])

    def test_a_reassignment_replaces_the_old_roles(self):
        first_id, _ = self.add_node(conn=RecordingConn())
        second_id, _ = self.add_node(address=("10.0.0.2", 1001), conn=RecordingConn())
        app.assign_node_roles([first_id, None, second_id])
        app.assign_node_roles([second_id, None, first_id])
        self.assertEqual(app.node_roles, {second_id: "LEFT", first_id: "RIGHT"})

    def test_a_node_that_connects_later_is_sent_its_role_after_its_id(self):
        app.assign_node_roles([1, None, None])
        conn = FakeNodeSocket(b"\r\n")
        app.handle_node_connection(conn, ("10.0.0.1", 1000))
        self.assertEqual(conn.sent, ["1\n", "ROLE LEFT\n"])

    def test_a_node_without_a_role_is_sent_none(self):
        conn = FakeNodeSocket(b"\r\n")
        app.handle_node_connection(conn, ("10.0.0.1", 1000))
        self.assertEqual(conn.sent, ["1\n"])

    def test_bad_slots_are_ignored(self):
        app.assign_node_roles([1, 2])
        app.assign_node_roles("left")
        self.assertEqual(app.node_roles, {})

    def test_the_browser_assignment_reaches_the_nodes_without_server_filtering(self):
        node_id, node = self.add_node(conn=RecordingConn())
        message = json.dumps({"type": "sensors:assign", "slots": [None, None, node_id]})
        socket = FakeBrowserSocket(incoming=[message])
        with mock.patch.object(app, "server_filter", None):
            asyncio.run(app.browser_handler(socket))
        self.assertEqual(node["conn"].sent, ["ROLE RIGHT\n"])


class ScannerAngleTests(unittest.TestCase):
    """The servo angle a scanner node sends alongside its distance."""

    def test_the_angle_is_read_as_a_number(self):
        self.assertEqual(app.parse_angle_deg({"angle": 112}), 112.0)
        self.assertEqual(app.parse_angle_deg({"angle": "64"}), 64.0)

    def test_no_angle_or_a_bad_one_is_none(self):
        for payload in ({}, {"angle": None}, {"angle": "left"}, {"angle": float("nan")}):
            self.assertIsNone(app.parse_angle_deg(payload), payload)


if __name__ == "__main__":
    unittest.main()
