"""
Tests for search.py: a node that loses the player checks the most likely cell
before it sweeps (Aaron, 6 Oct).

The firmware is simulated as Scanner::move has it: a lost reading sweeps the
servo SWEEP_STEP_DEG (reversing at a stop), except while the far hold keeps it
still; LOOK <deg> swings it there and forgets the last echo. Angles are whole
degrees, as the firmware sends them.

Run with:

    python -m unittest discover -s Website/tests
"""

import asyncio
import json
import math
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import app  # noqa: E402
from handover import Handover, bearing_deg  # noqa: E402
from search import (CHECK_READINGS, FAR_HOLD_PAIRS, FOUND, HALF_FOUND, LOOK_RETRY_S,  # noqa: E402
                    LOST, SEARCH_TIMEOUT_S, SERVO_LIMITS, Search, cell_name)
from test_app import BrokerTestCase, FakeBrowserSocket, FakeControlSocket, RecordingConn  # noqa: E402

LEFT, RIGHT = 1, 3
ROLES = {LEFT: "LEFT", RIGHT: "RIGHT"}
NODE_X = {"LEFT": 25.0, "RIGHT": 125.0}
SWEEP_STEP_DEG = 14       # src/Config.h
FAR_RANGE_CM = 100.0
READ_EVERY_S = 0.12
MIDDLE_CENTRE = (1, 1)    # (75, 85) on the default rows 10-160


def a_round(cell=None):
    """game:status's cursor, with the sensor's cell when one is given."""
    sensor = {"status": "ok", "gx": None, "gy": None}
    if cell is not None:
        sensor.update(gx=cell[0], gy=cell[1])
    return {"board": None, "hole": None, "remote": False, "sensor": sensor}


def aim(role, point):
    """The whole-degree angle that points the role's node at point."""
    low, high = SERVO_LIMITS[role]
    return int(round(min(high, max(low, bearing_deg(NODE_X[role], point)))))


class Firmware:
    """One node's servo, as Scanner::move and Scanner::lookAt move it."""

    def __init__(self, role="LEFT", angle=90):
        self.role = role
        self.angle = angle
        self.sweep_dir = 1
        self.last_heard = None
        self.far_lost = 0

    def after(self, state, distance):
        """Move as the firmware does after reporting a reading."""
        low, high = SERVO_LIMITS[self.role]
        if state != LOST:
            self.last_heard = distance
            self.far_lost = 0
            return
        at_stop = self.angle <= low or self.angle >= high
        if (self.last_heard is not None and self.last_heard >= FAR_RANGE_CM and not at_stop
                and self.far_lost < FAR_HOLD_PAIRS):
            self.far_lost += 1
            return
        self.last_heard = None
        self.far_lost = 0
        target = self.angle + SWEEP_STEP_DEG * self.sweep_dir
        if target > high or target < low:
            target = min(high, max(low, target))
            self.sweep_dir = -self.sweep_dir
        self.angle = target

    def look(self, degrees):
        low, high = SERVO_LIMITS[self.role]
        self.angle = min(high, max(low, degrees))
        self.last_heard = None
        self.far_lost = 0


class Rig:
    """One node feeding a Search the way app.py does, with the LOOKs obeyed."""

    def __init__(self, search=None, role="LEFT", angle=90, far_hold=True):
        self.search = search or Search()
        self.node_id = LEFT if role == "LEFT" else RIGHT
        self.firmware = Firmware(role, angle)
        self.far_hold = far_hold
        self.t = 100.0
        self.looks = []           # (angle read at, SearchLook)
        self.read_at = []         # the angle of every reading

    def show(self, cell=None):
        self.search.game_status(a_round(cell), self.t)

    def read(self, state, distance=-1.0, obey=True, **kwargs):
        """One reading at the servo's angle; then the firmware moves and any
        LOOK is obeyed. Returns the LOOK, if any."""
        angle = self.firmware.angle
        self.read_at.append(angle)
        look = self.search.record(self.node_id, self.firmware.role, state, distance, angle,
                                  self.t, far_hold=self.far_hold, **kwargs)
        self.firmware.after(state, distance)
        if look is not None:
            self.looks.append((angle, look))
            if obey:
                self.firmware.look(look.degrees)
        self.t = round(self.t + READ_EVERY_S, 6)
        self.search.game_status(a_round(self.search._shown_cell), self.t)
        return look

    def found(self, distance=60.0):
        return self.read(FOUND, distance)

    def lost(self, **kwargs):
        return self.read(LOST, **kwargs)

    def status(self):
        return self.search.status(self.node_id)


class SearchTests(unittest.TestCase):

    def test_a_lost_node_is_aimed_at_the_cell_the_game_shows(self):
        rig = Rig()
        rig.show(MIDDLE_CENTRE)
        rig.found()
        look = rig.lost()
        self.assertIsNotNone(look)
        self.assertEqual(look.cell, MIDDLE_CENTRE)
        self.assertEqual(look.degrees, aim("LEFT", (75.0, 85.0)))
        self.assertEqual(look.command, f"LOOK {look.degrees}")
        self.assertEqual(rig.status(), {"state": "checking", "checks": 0, "of": CHECK_READINGS,
                                        "cell": [1, 1], "name": "middle centre"})

    def test_three_lost_readings_at_the_cell_then_it_sweeps(self):
        rig = Rig()
        rig.show(MIDDLE_CENTRE)
        rig.found()
        target = rig.lost().degrees
        # Each lost reading at the cell sweeps the firmware a step; the LOOK
        # brings it back, until the third.
        for check in range(1, CHECK_READINGS):
            look = rig.lost()
            self.assertEqual(look.degrees, target)
            self.assertEqual(look.checks, check)
        self.assertIsNone(rig.lost())
        self.assertEqual(rig.read_at[-CHECK_READINGS:], [target] * CHECK_READINGS)
        self.assertEqual(rig.status()["state"], "sweeping")
        # From here on the firmware's sweep has it: no more LOOKs.
        for _ in range(10):
            self.assertIsNone(rig.lost())
        self.assertNotEqual(rig.firmware.angle, target)

    def test_a_node_lost_at_the_cell_counts_that_reading(self):
        rig = Rig(angle=aim("LEFT", (75.0, 85.0)))
        rig.show(MIDDLE_CENTRE)
        rig.found()
        self.assertEqual(rig.lost().checks, 1)

    def test_finding_the_player_at_the_cell_ends_the_search(self):
        rig = Rig()
        rig.show(MIDDLE_CENTRE)
        rig.found()
        rig.lost()
        self.assertIsNone(rig.read(HALF_FOUND, 80.0))
        self.assertIsNone(rig.status())
        # A later loss is a new search.
        self.assertIsNotNone(rig.lost())

    def test_after_the_sweep_it_searches_again_only_once_it_has_found_someone(self):
        rig = Rig()
        rig.show(MIDDLE_CENTRE)
        rig.found()
        for _ in range(CHECK_READINGS + 1):
            rig.lost()
        self.assertEqual(rig.status()["state"], "sweeping")
        self.assertIsNone(rig.lost())
        rig.found()
        self.assertIsNotNone(rig.lost())

    def test_the_highest_confidence_cell_wins_over_the_shown_one(self):
        rig = Rig()
        rig.show(MIDDLE_CENTRE)
        scores = [0.0] * 9
        scores[0 * 3 + 2] = 0.7      # back left
        scores[1 * 3 + 1] = 0.4      # middle centre, the shown cell
        rig.search.set_scores(scores)
        rig.found()
        look = rig.lost()
        self.assertEqual(look.cell, (0, 2))
        self.assertEqual(look.degrees, aim("LEFT", (25.0, 135.0)))
        self.assertEqual(cell_name(look.cell), "back left")

    def test_a_tie_goes_to_the_shown_cell(self):
        rig = Rig()
        rig.show(MIDDLE_CENTRE)
        scores = [0.0] * 9
        scores[0] = scores[4] = 0.5
        rig.search.set_scores(scores)
        rig.found()
        self.assertEqual(rig.lost().cell, MIDDLE_CENTRE)

    def test_all_zero_scores_fall_back_to_the_shown_cell(self):
        rig = Rig()
        rig.show((2, 0))
        rig.search.set_scores([0.0] * 9)
        rig.found()
        self.assertEqual(rig.lost().cell, (2, 0))

    def test_bad_scores_are_refused(self):
        search = Search()
        for scores in ([1.0] * 8, [1.0] * 10, [math.nan] * 9, None):
            with self.assertRaises((ValueError, TypeError)):
                search.set_scores(scores)

    def test_far_hold_goes_first(self):
        # After an echo 120 cm out the firmware holds for 3 lost readings;
        # the LOOK goes with the last of them, so the 4th is at the cell.
        rig = Rig()
        rig.show(MIDDLE_CENTRE)
        rig.found(120.0)
        held_at = rig.firmware.angle
        for _ in range(FAR_HOLD_PAIRS - 1):
            self.assertIsNone(rig.lost())
            self.assertEqual(rig.firmware.angle, held_at)
        look = rig.lost()
        self.assertIsNotNone(look)
        self.assertEqual(rig.read_at[-FAR_HOLD_PAIRS:], [held_at] * FAR_HOLD_PAIRS)
        rig.lost()
        self.assertEqual(rig.read_at[-1], look.degrees)

    def test_with_far_hold_off_it_goes_at_once(self):
        rig = Rig(far_hold=False)
        rig.show(MIDDLE_CENTRE)
        rig.found(120.0)
        self.assertIsNotNone(rig.lost())

    def test_no_far_hold_at_a_servo_stop(self):
        rig = Rig(angle=SERVO_LIMITS["LEFT"][1])
        rig.show(MIDDLE_CENTRE)
        rig.found(120.0)
        self.assertIsNotNone(rig.lost())

    def test_a_near_echo_has_no_far_hold(self):
        rig = Rig()
        rig.show(MIDDLE_CENTRE)
        rig.found(60.0)
        self.assertIsNotNone(rig.lost())

    def test_after_a_handover_look_there_is_no_far_hold(self):
        rig = Rig()
        rig.show(MIDDLE_CENTRE)
        rig.found(120.0)
        rig.search.looked(rig.node_id)
        self.assertIsNotNone(rig.lost())

    def test_no_round_on_screen_no_search(self):
        rig = Rig()
        rig.found()
        self.assertIsNone(rig.lost())
        self.assertIsNone(rig.status())
        # The round appears with a cell: the next lost reading searches.
        rig.show(MIDDLE_CENTRE)
        self.assertIsNotNone(rig.lost())

    def test_a_round_with_no_cell_yet_has_no_target(self):
        rig = Rig()
        rig.show(None)
        rig.found()
        self.assertIsNone(rig.lost())

    def test_the_game_page_gone_quiet_is_no_round(self):
        search = Search()
        search.game_status(a_round(MIDDLE_CENTRE), 100.0)
        self.assertEqual(search.target_cell(101.0), MIDDLE_CENTRE)
        self.assertIsNone(search.target_cell(103.0))

    def test_leaving_the_round_forgets_the_shown_cell(self):
        search = Search()
        search.game_status(a_round(MIDDLE_CENTRE), 100.0)
        search.game_status(None, 100.1)
        search.game_status(a_round(None), 100.2)
        self.assertIsNone(search.target_cell(100.2))

    def test_a_new_round_forgets_the_scores_and_every_search(self):
        rig = Rig()
        rig.show(MIDDLE_CENTRE)
        rig.search.set_scores([0.0] * 8 + [0.9])
        rig.found()
        rig.lost()
        rig.search.reset()
        self.assertIsNone(rig.status())
        self.assertIsNone(rig.search.target_cell(rig.t))

    def test_switched_off_a_lost_node_sweeps_at_once(self):
        rig = Rig(search=Search(enabled=False))
        rig.show(MIDDLE_CENTRE)
        rig.found()
        self.assertIsNone(rig.lost())
        self.assertIsNone(rig.status())

    def test_nothing_while_calibration_holds_the_servos_or_the_room_is_learnt(self):
        rig = Rig()
        rig.show(MIDDLE_CENTRE)
        rig.found()
        self.assertIsNone(rig.lost(held=True))
        self.assertIsNone(rig.lost(room=1))
        self.assertIsNone(rig.status())

    def test_nothing_without_a_role(self):
        search = Search()
        search.game_status(a_round(MIDDLE_CENTRE), 100.0)
        self.assertIsNone(search.record(LEFT, None, LOST, -1.0, 90, 100.0))

    def test_a_reading_from_before_the_look_does_not_resend_it_at_once(self):
        rig = Rig()
        rig.show(MIDDLE_CENTRE)
        rig.found()
        target = rig.lost(obey=False).degrees
        # Still on its way: the next reading is not at the cell.
        self.assertIsNone(rig.lost(obey=False))
        while rig.t - 100.0 < LOOK_RETRY_S + 2 * READ_EVERY_S:
            look = rig.lost(obey=False)
        self.assertIsNotNone(look)
        self.assertEqual(look.degrees, target)

    def test_a_search_that_never_gets_there_is_given_up(self):
        rig = Rig()
        rig.show(MIDDLE_CENTRE)
        rig.found()
        rig.lost(obey=False)
        for _ in range(int(SEARCH_TIMEOUT_S / READ_EVERY_S) + 2):
            rig.lost(obey=False)
        self.assertEqual(rig.status()["state"], "sweeping")

    def test_the_bearing_stays_inside_the_servo_limits(self):
        search = Search()
        # The RIGHT node cannot turn to the front left cell's centre (25, 35).
        self.assertLess(bearing_deg(NODE_X["RIGHT"], (25.0, 35.0)), SERVO_LIMITS["RIGHT"][0])
        self.assertEqual(search.bearing_to("RIGHT", (0, 0)), SERVO_LIMITS["RIGHT"][0])
        self.assertEqual(search.bearing_to("LEFT", (0, 1)), 90)

    def test_calibration_moves_the_cells(self):
        search = Search()
        self.assertEqual(search.cell_centre((1, 2)), (75.0, 135.0))
        search.set_calibration([(20.0, 140.0)] * 3)
        self.assertEqual(search.cell_centre((1, 2)), (75.0, 120.0))

    def test_cell_names(self):
        self.assertEqual(cell_name((0, 0)), "front left")
        self.assertEqual(cell_name((2, 2)), "back right")


class HandoverBusyTests(unittest.TestCase):

    def test_the_handover_leaves_a_node_the_search_is_aiming_alone(self):
        handover = Handover()
        player = (60.0, 90.0)
        distance = math.hypot(player[0] - 25.0, player[1])
        angle = round(bearing_deg(25.0, player))
        t = 0.0
        while t < 6.0:
            handover.record(LEFT, distance, angle, t)
            t += READ_EVERY_S
        has_turn = {LEFT: True, RIGHT: False}
        self.assertEqual(handover.commands(ROLES, has_turn, t, busy={RIGHT}), [])
        self.assertIsNone(handover.status(RIGHT, "RIGHT", t)["following"])
        self.assertEqual(len(handover.commands(ROLES, has_turn, t)), 1)


class AppSearchTests(BrokerTestCase):
    """The same search, through app.update_node and the nodes' sockets."""

    def setUp(self):
        super().setUp()
        self._saved_roles = dict(app.node_roles)
        app.node_roles.clear()
        self.clock = [100.0]
        self._time = mock.patch.object(app.time, "monotonic", lambda: self.clock[0])
        self._time.start()

    def tearDown(self):
        self._time.stop()
        app.node_roles.clear()
        app.node_roles.update(self._saved_roles)
        super().tearDown()

    def two_nodes(self):
        left_conn, right_conn = RecordingConn(), RecordingConn()
        left_id, left = self.add_node(("10.0.0.1", 1000), conn=left_conn)
        right_id, right = self.add_node(("10.0.0.2", 1000), conn=right_conn)
        app.node_roles.update({left_id: "LEFT", right_id: "RIGHT"})
        left["has_turn"], right["has_turn"] = True, False
        return (left_id, left_conn), (right_id, right_conn)

    def reading(self, node_id, distance, angle, state):
        app.update_node(node_id, json.dumps({"distance": distance, "angle": angle,
                                             "scanState": state}))
        self.clock[0] += READ_EVERY_S

    def test_a_lost_node_is_sent_the_look_over_its_socket(self):
        (left_id, left_conn), _ = self.two_nodes()
        app.note_game_status(a_round(MIDDLE_CENTRE))
        self.reading(left_id, 60.0, 90, FOUND)
        self.reading(left_id, -1.0, 104, LOST)
        expected = aim("LEFT", (75.0, 85.0))
        self.assertIn(f"LOOK {expected}\n", left_conn.sent)
        status = app.serialize_node(app.nodes[left_id])["search"]
        self.assertEqual(status["state"], "checking")
        self.assertEqual(status["name"], "middle centre")

        app.mark_node_offline(left_id)
        self.assertIsNone(app.search.status(left_id))

    def test_the_game_sends_its_cells_and_rounds(self):
        (left_id, left_conn), _ = self.two_nodes()
        app.note_game_status(a_round(MIDDLE_CENTRE))
        app.apply_search_event({"type": "cells:confidence", "scores": [0.0] * 8 + [0.5]})
        self.assertEqual(app.search.target_cell(self.clock[0]), (2, 2))
        app.apply_search_event({"type": "round:start"})
        self.assertIsNone(app.search.target_cell(self.clock[0]))
        app.apply_search_event({"type": "calibration:update",
                                "perColumn": [{"near": 20, "far": 140}] * 3})
        self.assertEqual(app.search.cell_centre((1, 2)), (75.0, 120.0))
        with mock.patch("builtins.print") as printed:
            app.apply_search_event({"type": "cells:confidence", "scores": [1, 2]})
        self.assertIn("Ignored bad cells:confidence", printed.call_args.args[0])

    def test_game_status_reaches_the_search_from_the_browser(self):
        message = json.dumps({"type": "game:status", "cursor": a_round(MIDDLE_CENTRE)})
        with mock.patch.object(app, "server_filter", None):
            asyncio.run(app.browser_handler(FakeBrowserSocket(incoming=[message])))
        self.assertEqual(app.search.target_cell(self.clock[0]), MIDDLE_CENTRE)

    def test_the_far_hold_goes_by_the_nearer_sensor_as_the_firmware_does(self):
        (left_id, left_conn), _ = self.two_nodes()
        app.note_game_status(a_round(MIDDLE_CENTRE))
        # Found at 104 cm on average, but the nearer sensor heard 96: no far hold.
        app.update_node(left_id, json.dumps({"distance": 104.0, "left": 96.0, "right": 112.0,
                                             "angle": 90, "scanState": FOUND}))
        app.update_node(left_id, json.dumps({"distance": -1.0, "left": -1.0, "right": -1.0,
                                             "angle": 90, "scanState": LOST}))
        self.assertTrue(any(line.startswith("LOOK") for line in left_conn.sent))
        self.assertEqual(app.parse_nearest_echo_cm({"left": -1.0, "right": 150.0}), 150.0)
        self.assertIsNone(app.parse_nearest_echo_cm({"left": -1.0, "right": -1.0, "distance": 80}))
        self.assertEqual(app.parse_nearest_echo_cm({"distance": 80}), 80.0)

    def test_search_off_sends_no_look(self):
        (left_id, left_conn), _ = self.two_nodes()
        app.set_search(False)
        app.note_game_status(a_round(MIDDLE_CENTRE))
        self.reading(left_id, 60.0, 90, FOUND)
        self.reading(left_id, -1.0, 104, LOST)
        self.assertFalse(any(line.startswith("LOOK") for line in left_conn.sent))
        self.assertIsNone(app.serialize_node(app.nodes[left_id])["search"])

    def test_the_control_panel_switch_turns_the_search_off_and_on(self):
        events = [{"action": "search", "enabled": False}, {"action": "search", "enabled": True}]
        phone = FakeControlSocket(path="/control", incoming=[json.dumps(e) for e in events])
        with mock.patch.object(app, "broadcast") as broadcast:
            asyncio.run(app.control_handler(phone))
        self.assertIn(json.dumps({"type": "search:status", "on": True}), phone.sent)
        statuses = [json.loads(call.args[1]) for call in broadcast.call_args_list]
        self.assertEqual(statuses, [{"type": "search:status", "on": False},
                                    {"type": "search:status", "on": True}])
        self.assertTrue(app.search.enabled)


if __name__ == "__main__":
    unittest.main()
