"""
Tests for handover.py: a node's confidence, and aiming the other node at it.

The rig is simulated as app.py runs it: two nodes, LEFT and RIGHT, taking
1 s scan turns (LEFT first), each reporting about every 0.12 s while it holds
the turn and nothing while it does not. Angles are whole degrees, as the
firmware sends them.

Run with:

    python -m unittest discover -s Website/tests
"""

import json
import math
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import app  # noqa: E402
from handover import NO_CONFIDENCE, Handover, bearing_deg  # noqa: E402
from test_app import BrokerTestCase, RecordingConn  # noqa: E402

LEFT, RIGHT = 1, 3
ROLES = {LEFT: "LEFT", RIGHT: "RIGHT"}
NODE_X = {LEFT: 25.0, RIGHT: 125.0}
TURN_S = 1.0
READ_EVERY_S = 0.12
PLAYER = (60.0, 90.0)


def aimed_at(node_id, point):
    """What a node pointed straight at point reports: (distance, angle)."""
    x = NODE_X[node_id]
    return math.hypot(point[0] - x, point[1]), round(bearing_deg(x, point))


def sees(node_id, point, room=None):
    """A node locked on to a player standing at point."""
    distance, angle = aimed_at(node_id, point)
    return lambda t, i: (distance, angle, room)


def lost(room=None):
    """A node that sees nothing and sweeps, 14 degrees a reading."""
    return lambda t, i: (-1.0, 40 + (i * 14) % 120, room)


class Rig:
    """Feeds a Handover the way app.py does: record, then ask for LOOKs."""

    def __init__(self, handover=None, roles=ROLES, held=False):
        self.handover = handover or Handover()
        self.roles = roles
        self.held = held
        self.t = 0.0
        self.count = {LEFT: 0, RIGHT: 0}
        self.looks = []          # (t, Look)

    @staticmethod
    def turn_at(t):
        return LEFT if int(t // TURN_S) % 2 == 0 else RIGHT

    def run(self, seconds, left=None, right=None):
        sources = {LEFT: left, RIGHT: right}
        end = self.t + seconds
        while self.t < end - 1e-9:
            turn = self.turn_at(self.t)
            source = sources[turn]
            if source is not None:
                distance, angle, room = source(self.t, self.count[turn])
                self.count[turn] += 1
                self.handover.record(turn, distance, angle, self.t, room=room)
                has_turn = {LEFT: turn == LEFT, RIGHT: turn == RIGHT}
                for look in self.handover.commands(self.roles, has_turn, self.t, held=self.held):
                    self.looks.append((self.t, look))
            self.t = round(self.t + READ_EVERY_S, 6)

    def confidence(self, node_id):
        return self.handover.confidence(node_id, ROLES[node_id], self.t)


class ConfidenceTests(unittest.TestCase):

    def test_a_player_standing_still_makes_the_node_confident(self):
        rig = Rig()
        rig.run(6.0, left=sees(LEFT, PLAYER), right=lost())
        c = rig.confidence(LEFT)
        self.assertTrue(c.confident)
        self.assertEqual(c.score, 1.0)
        self.assertLess(math.dist(c.point, PLAYER), 2.0, c.point)
        self.assertLess(c.spread_cm, 1.0)

        other = rig.confidence(RIGHT)
        self.assertFalse(other.confident)
        self.assertEqual(other.score, 0.0)
        self.assertIsNone(other.point)

    def test_not_before_it_has_been_reporting_for_five_seconds(self):
        rig = Rig()
        rig.run(4.5, left=sees(LEFT, PLAYER), right=lost())
        self.assertFalse(rig.confidence(LEFT).confident)
        rig.run(0.8, left=sees(LEFT, PLAYER), right=lost())
        self.assertTrue(rig.confidence(LEFT).confident)

    def test_the_odd_dropped_echo_does_not_reset_it(self):
        distance, angle = aimed_at(LEFT, PLAYER)
        flaky = lambda t, i: (-1.0 if i % 7 == 3 else distance, angle, None)  # 1 in 7 dropped
        rig = Rig()
        rig.run(6.0, left=flaky, right=lost())
        self.assertTrue(rig.confidence(LEFT).confident)

    def test_too_many_dropped_echoes_is_not_confident(self):
        distance, angle = aimed_at(LEFT, PLAYER)
        flaky = lambda t, i: (-1.0 if i % 3 == 0 else distance, angle, None)  # 1 in 3 dropped
        rig = Rig()
        rig.run(8.0, left=flaky, right=lost())
        c = rig.confidence(LEFT)
        self.assertFalse(c.confident)
        self.assertLess(c.score, 0.8)

    def test_a_walking_player_is_not_at_one_place(self):
        # Across the board at 15 cm/s: about 75 cm in any 5 s.
        walking = lambda t, i: (*aimed_at(LEFT, (30 + 15 * t, 90.0)), None)
        rig = Rig()
        rig.run(8.0, left=walking, right=lost())
        self.assertFalse(rig.confidence(LEFT).confident)

    def test_a_player_who_walks_up_must_be_seen_for_most_of_the_window(self):
        rig = Rig()
        rig.run(6.0, left=lost(), right=lost())
        rig.run(2.5, left=sees(LEFT, PLAYER), right=lost())
        self.assertFalse(rig.confidence(LEFT).confident, "the readings from before still outweigh them")
        rig.run(3.0, left=sees(LEFT, PLAYER), right=lost())
        self.assertTrue(rig.confidence(LEFT).confident)

    def test_a_room_that_is_not_learnt_yet_never_makes_it_confident(self):
        rig = Rig()
        rig.run(8.0, left=sees(LEFT, PLAYER, room=0), right=lost(room=0))
        self.assertFalse(rig.confidence(LEFT).confident, "before the room is learnt a chair looks like this")
        rig = Rig()
        rig.run(6.0, left=sees(LEFT, PLAYER, room=2), right=lost(room=2))
        self.assertTrue(rig.confidence(LEFT).confident)

    def test_without_a_role_there_is_no_confidence(self):
        rig = Rig()
        rig.run(6.0, left=sees(LEFT, PLAYER), right=lost())
        self.assertIs(rig.handover.confidence(LEFT, None, rig.t), NO_CONFIDENCE)
        self.assertIsNone(rig.handover.status(LEFT, None, rig.t))

    def test_status_is_what_nodes_update_carries(self):
        rig = Rig()
        rig.run(6.0, left=sees(LEFT, PLAYER), right=lost())
        status = rig.handover.status(LEFT, "LEFT", rig.t)
        self.assertEqual(set(status), {"score", "spread_cm", "point_cm", "confident", "following"})
        self.assertTrue(status["confident"])
        self.assertIsNone(status["following"])
        self.assertEqual(rig.handover.status(RIGHT, "RIGHT", rig.t)["following"], LEFT)
        json.dumps(status)


class HandoverTests(unittest.TestCase):

    def test_the_other_node_is_aimed_at_the_confident_point(self):
        # LEFT is confident from about 5 s, in RIGHT's turn, so RIGHT is aimed
        # as LEFT's next turn starts.
        rig = Rig()
        rig.run(7.0, left=sees(LEFT, PLAYER), right=lost())
        self.assertTrue(rig.looks, "a confident LEFT should aim RIGHT")
        t, look = rig.looks[0]
        self.assertEqual(look.node_id, RIGHT)
        self.assertEqual(look.source_id, LEFT)
        self.assertAlmostEqual(look.degrees, bearing_deg(NODE_X[RIGHT], PLAYER), delta=1.0)
        self.assertEqual(look.command, f"LOOK {look.degrees}")
        self.assertGreaterEqual(t, 6.0)

    def test_a_look_never_goes_to_the_node_holding_the_turn(self):
        rig = Rig()
        rig.run(12.0, left=sees(LEFT, PLAYER), right=lost())
        self.assertTrue(rig.looks)
        for t, look in rig.looks:
            self.assertNotEqual(Rig.turn_at(t), look.node_id, f"LOOK at {t} s went mid-turn")

    def test_it_keeps_following_when_the_other_node_sweeps_away(self):
        # RIGHT sees nothing at the point and sweeps off in its turns, so each
        # of LEFT's turns aims it back - once, not on every reading.
        swept_off = lambda t, i: (-1.0, 50 + (i * 14) % 40, None)   # never near the point
        rig = Rig()
        rig.run(12.0, left=sees(LEFT, PLAYER), right=swept_off)
        turns = {int(t // TURN_S) for t, _ in rig.looks}
        self.assertEqual(len(turns), len(rig.looks), "one LOOK per turn at most")
        self.assertGreaterEqual(len(rig.looks), 3)

    def test_it_is_not_re_aimed_while_it_still_points_there(self):
        rig = Rig()
        rig.run(7.0, left=sees(LEFT, PLAYER), right=lost())
        sent = len(rig.looks)
        self.assertEqual(sent, 1)
        # RIGHT stays silent (no turn of its own reported), so it still points
        # where it was sent: LEFT's next turn sends nothing new.
        rig.run(2.0, left=sees(LEFT, PLAYER), right=None)
        self.assertEqual(len(rig.looks), sent)

    def test_it_is_re_aimed_when_the_player_moves(self):
        rig = Rig()
        rig.run(7.0, left=sees(LEFT, PLAYER), right=lost())
        moved = (40.0, 110.0)
        rig.run(8.0, left=sees(LEFT, moved), right=None)
        first, last = rig.looks[0][1], rig.looks[-1][1]
        self.assertAlmostEqual(first.degrees, bearing_deg(NODE_X[RIGHT], PLAYER), delta=1.0)
        self.assertAlmostEqual(last.degrees, bearing_deg(NODE_X[RIGHT], moved), delta=1.0)

    def test_once_it_sees_the_player_itself_it_is_left_alone(self):
        rig = Rig()
        rig.run(7.0, left=sees(LEFT, PLAYER), right=lost())
        self.assertTrue(rig.looks)
        rig.run(1.0, right=sees(RIGHT, (62.0, 88.0)))  # RIGHT's turn: it finds them
        sent = len(rig.looks)
        rig.run(6.0, left=sees(LEFT, PLAYER), right=sees(RIGHT, (62.0, 88.0)))
        self.assertEqual(len(rig.looks), sent, "it agrees, so it tracks on its own")
        self.assertIsNone(rig.handover.status(RIGHT, "RIGHT", rig.t)["following"])

    def test_both_seeing_the_player_sends_nothing(self):
        rig = Rig()
        rig.run(12.0, left=sees(LEFT, PLAYER), right=sees(RIGHT, PLAYER))
        self.assertEqual(rig.looks, [])
        self.assertTrue(rig.confidence(LEFT).confident and rig.confidence(RIGHT).confident)

    def test_nothing_while_calibration_holds_the_servos(self):
        rig = Rig(held=True)
        rig.run(8.0, left=sees(LEFT, PLAYER), right=lost())
        self.assertEqual(rig.looks, [])

    def test_nothing_until_both_nodes_have_roles(self):
        rig = Rig(roles={LEFT: "LEFT"})
        rig.run(8.0, left=sees(LEFT, PLAYER), right=lost())
        self.assertEqual(rig.looks, [])

    def test_steering_off_still_says_who_would_be_aimed(self):
        rig = Rig(handover=Handover(steer=False))
        rig.run(8.0, left=sees(LEFT, PLAYER), right=lost())
        self.assertEqual(rig.looks, [])
        self.assertEqual(rig.handover.status(RIGHT, "RIGHT", rig.t)["following"], LEFT)

    def test_a_node_learning_the_room_is_never_aimed(self):
        rig = Rig()
        rig.run(8.0, left=sees(LEFT, PLAYER), right=lost(room=1))
        self.assertEqual(rig.looks, [])
        self.assertIsNone(rig.handover.status(RIGHT, "RIGHT", rig.t)["following"])


class AppHandoverTests(BrokerTestCase):
    """The same handover, through app.update_node and the nodes' sockets."""

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

    def test_a_confident_node_aims_the_other_one_over_its_socket(self):
        left_conn, right_conn = RecordingConn(), RecordingConn()
        left_id, left = self.add_node(("10.0.0.1", 1000), conn=left_conn)
        right_id, right = self.add_node(("10.0.0.2", 1000), conn=right_conn)
        app.node_roles.update({left_id: "LEFT", right_id: "RIGHT"})
        left["has_turn"], right["has_turn"] = True, False

        x = NODE_X[LEFT]
        distance = math.hypot(PLAYER[0] - x, PLAYER[1])
        angle = round(bearing_deg(x, PLAYER))
        for _ in range(50):  # 6 s of LEFT's readings
            app.update_node(left_id, json.dumps({"avg": distance, "angle": angle, "scanState": 0}))
            self.clock[0] += READ_EVERY_S

        expected = round(bearing_deg(NODE_X[RIGHT], PLAYER))
        self.assertIn(f"LOOK {expected}\n", right_conn.sent)
        self.assertFalse(any(line.startswith("LOOK") for line in left_conn.sent))
        self.assertTrue(app.serialize_node(left)["confidence"]["confident"])
        self.assertEqual(app.serialize_node(right)["confidence"]["following"], left_id)

        # Offline, nothing it said still holds.
        app.mark_node_offline(left_id)
        self.assertIsNone(app.serialize_node(app.nodes[left_id])["confidence"])

    def test_handover_off_sends_no_look(self):
        app.handover = app.Handover(steer=False)
        right_conn = RecordingConn()
        left_id, left = self.add_node(("10.0.0.1", 1000), conn=RecordingConn())
        right_id, _ = self.add_node(("10.0.0.2", 1000), conn=right_conn)
        app.node_roles.update({left_id: "LEFT", right_id: "RIGHT"})
        left["has_turn"] = True

        distance, angle = aimed_at(LEFT, PLAYER)
        for _ in range(50):
            app.update_node(left_id, json.dumps({"avg": distance, "angle": angle}))
            self.clock[0] += READ_EVERY_S
        self.assertFalse(any(line.startswith("LOOK") for line in right_conn.sent))


if __name__ == "__main__":
    unittest.main()
