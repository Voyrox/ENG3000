"""
Tests for Website/tools/centre_test.py, the centre column rig test.

The run is synthetic and built here through the tool's own logger, fed the
messages the control panel's feed would carry. In it the LEFT node, on its own,
puts a player standing halfway between the nodes at x = 105 (the right column)
and the RIGHT node puts them at x = 70, and the game's x follows whichever node
holds the scan turn - so x leaves the centre column on every LEFT turn.

    python -m unittest discover -s Website/tests
"""

import csv
import json
import math
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WEBSITE = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(WEBSITE, "tools"))

import centre_test as ct  # noqa: E402

LEFT_ID, RIGHT_ID = 7, 3        # not 1 and 2, so nothing can lean on the ids
MAC = "AA:BB:CC:DD:EE:FF"


def reading_for(role, x, y):
    """The (distance, angle) a node at the game's position reports for a
    player whose middle is at (x, y): the distance to the side of them nearest
    it, and the angle the game's way (larger turns towards screen-right)."""
    node_x = ct.GAME_NODE_X[role]
    return (math.hypot(x - node_x, y) - ct.BODY_RADIUS_CM,
            90 + math.degrees(math.atan2(x - node_x, y)))


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


class FakeRig:
    """Builds a run folder: per 0.1 s tick, one new reading from the node
    holding the turn, then the game's status."""

    def __init__(self, folder):
        self.clock = Clock()
        self.log = ct.RunLog(folder, clock=self.clock)
        self.folder = folder
        self.stamp = 0
        self.latest = {LEFT_ID: {}, RIGHT_ID: {}}
        self.seen = {LEFT_ID: 0, RIGHT_ID: 0}
        self.steps = []
        self.nodes(holder=LEFT_ID)        # what is there when the log opens

    def nodes(self, holder, reader=None, payload=None):
        if reader is not None:
            self.stamp += 1
            self.seen[reader] = self.stamp
            self.latest[reader] = {"nodeId": reader, "mac": MAC, **payload}
        self.log.on_message({"type": "nodes:update", "nodes": [
            {"id": node_id, "online": True, "has_turn": node_id == holder,
             "last_seen": self.seen[node_id], "latest": json.dumps(self.latest[node_id])}
            for node_id in (LEFT_ID, RIGHT_ID)]})

    def status(self, x, tri_x):
        self.log.on_message({"type": "game:status", "screen": "game", "mode": "sensor",
                             "status": "playing", "positionMethod": "los", "cursor": {
                                 "board": {"nx": 0.5, "ny": 0.5}, "hole": -1,
                                 "sensor": {"status": "ok", "held": False, "source": "both",
                                            "xCm": x, "yCm": 80, "distanceCm": 80,
                                            "gx": ct.column_at(x), "gy": 1, "method": "los",
                                            "fixes": {"los": {"xCm": x, "yCm": 80},
                                                      "tri": {"xCm": tri_x, "yCm": 80},
                                                      "avg": {"xCm": (x + tri_x) / 2, "yCm": 80}}}}})

    def step(self, step, seconds, read, status_every=1):
        """read(role) -> (payload for the node's reading, x the game shows).
        status_every > 1 is a hidden game page: one status in that many ticks."""
        self.log.set_step(step.name, "record")
        start = self.clock.t
        for k in range(int(seconds * 10)):
            self.clock.t = round(start + k * 0.1, 3)
            holder = LEFT_ID if (k // 10) % 2 == 0 else RIGHT_ID
            role = "LEFT" if holder == LEFT_ID else "RIGHT"
            payload, x = read(role)
            self.nodes(holder, holder, payload)
            if k % status_every == 0:
                self.status(x, tri_x=step.x_cm)
        self.clock.t = round(start + seconds, 3)
        self.log.set_step("", "between")
        self.steps.append({**ct.asdict(step), "start_s": start, "end_s": self.clock.t})
        self.clock.t += 2

    def finish(self):
        self.log.close()
        (self.folder / "run.json").write_text(json.dumps({
            "started": "test", "spacing_cm": 100, "method": "los", "steps": self.steps}))


def found(role, x, y, mirror=False):
    """A found reading of (x, y); mirror: from a servo that turns the other
    way from the game's assumption (angle 180 - a)."""
    distance, angle = reading_for(role, x, y)
    return {"left": distance, "right": distance, "avg": distance,
            "angle": round(180 - angle if mirror else angle, 1), "scanState": 0, "room": 2}


LOST_AT = {"LEFT": 160, "RIGHT": 30}     # each servo's inward limit (src/Config.h)


def lost(role):
    return {"left": -1, "right": -1, "avg": -1, "angle": LOST_AT[role], "scanState": 2, "room": 2}


def build_run(folder, mirror=False, status_every=1):
    from pathlib import Path
    rig = FakeRig(Path(folder))
    steps = {s.name: s for s in ct.plan_steps()}
    # Control spots: the node in front sees the player straight on; the other
    # cannot turn that far and is lost at its inward limit.
    rig.step(steps["L-80"], 4, lambda role: (found("LEFT", 25, 80, mirror), 25) if role == "LEFT"
             else (lost("RIGHT"), 25), status_every)
    rig.step(steps["R-80"], 4, lambda role: (found("RIGHT", 125, 80, mirror), 125) if role == "RIGHT"
             else (lost("LEFT"), 125), status_every)
    # Centre: LEFT alone says x = 105, RIGHT alone says x = 70.
    rig.step(steps["C-80"], 6, lambda role: (found("LEFT", 105, 80, mirror), 105) if role == "LEFT"
             else (found("RIGHT", 70, 80, mirror), 70), status_every)
    rig.finish()
    return Path(folder)


def build_mirrored_run(folder):
    """A rig whose servos turn the other way from the game's assumption (as
    on 4 Oct, before the game was turned round to match), so a still player is
    seen at one point by both nodes only when the angles are mirrored. Both
    nodes see every spot."""
    from pathlib import Path
    rig = FakeRig(Path(folder))
    steps = {s.name: s for s in ct.plan_steps()}
    for name in ("L-80", "R-80", "C-80", "C-120"):
        step = steps[name]
        rig.step(step, 4, lambda role, s=step: (found(role, s.x_cm, s.y_cm, mirror=True), s.x_cm))
    rig.finish()
    return Path(folder)


class GeometryTest(unittest.TestCase):
    def test_a_reading_aimed_at_a_spot_lands_on_it(self):
        for role in ct.ROLES:
            for x, y in ((75, 40), (75, 80), (25, 80), (125, 120), (60, 100)):
                angle = ct.expected_angle(role, 100, x, y)
                # A reading is to the near side of the player.
                distance = ct.expected_distance(role, 100, x, y) - ct.BODY_RADIUS_CM
                px, py = ct.own_point(role, distance, angle)
                self.assertAlmostEqual(px, x, places=6)
                self.assertAlmostEqual(py, y, places=6)

    def test_angles_that_face_the_centre(self):
        self.assertAlmostEqual(ct.expected_angle("LEFT", 100, 75, 80), 90 + 32.005, places=2)
        self.assertAlmostEqual(ct.expected_angle("RIGHT", 100, 75, 80), 90 - 32.005, places=2)
        # 40 cm out, halfway: inside both servos' travel (src/Config.h).
        self.assertGreater(ct.expected_angle("LEFT", 100, 75, 40), 90)
        self.assertLessEqual(ct.expected_angle("LEFT", 100, 75, 40), ct.inward_limit("LEFT"))
        self.assertGreaterEqual(ct.expected_angle("RIGHT", 100, 75, 40), ct.inward_limit("RIGHT"))
        # Turning the other way, the same spot is past both servos' inward limits.
        self.assertLess(ct.expected_angle("LEFT", 100, 75, 40, -1), ct.inward_limit("LEFT", -1))
        self.assertGreater(ct.expected_angle("RIGHT", 100, 75, 40, -1), ct.inward_limit("RIGHT", -1))

    def test_the_other_direction_mirrors_x_about_each_node(self):
        x, y = ct.own_point("LEFT", 100, 120, sign=-1)
        gx, gy = ct.own_point("LEFT", 100, 120)
        self.assertAlmostEqual(x - 25, 25 - gx)
        self.assertAlmostEqual(y, gy)

    def test_tape_marks(self):
        marks = {name: (left, right) for name, left, right in ct.tape_marks(100)}
        self.assertEqual(sorted(marks), ["C-120", "C-40", "C-80", "L-80", "R-80"])
        self.assertAlmostEqual(marks["L-80"][0], 80)
        self.assertAlmostEqual(marks["L-80"][1], math.hypot(100, 80))       # 128.1
        self.assertAlmostEqual(marks["C-80"][0], math.hypot(50, 80))        # 94.3
        self.assertAlmostEqual(marks["C-80"][0], marks["C-80"][1])
        self.assertAlmostEqual(dict((n, l) for n, l, _ in ct.tape_marks(120))["C-40"],
                               math.hypot(60, 40))

    def test_spots_follow_the_real_spacing(self):
        steps = {s.name: s for s in ct.plan_steps(spacing_cm=120)}
        self.assertEqual(steps["L-80"].x_cm, 15)
        self.assertEqual(steps["R-80"].x_cm, 135)
        self.assertEqual(steps["C-40"].x_cm, 75)
        self.assertEqual(steps["C-40"].column, 1)
        # A node faces its own spot straight on, wherever it really is.
        self.assertAlmostEqual(ct.expected_angle("LEFT", 120, 15, 80), 90)


class LoggerTest(unittest.TestCase):
    def test_new_readings_and_turns_only_and_no_mac(self):
        with tempfile.TemporaryDirectory() as folder:
            rig = FakeRig(__import__("pathlib").Path(folder))
            rig.log.set_step("C-80", "record")
            rig.clock.t = 1.0
            rig.nodes(LEFT_ID)                                    # nothing new
            rig.clock.t = 1.1
            rig.nodes(LEFT_ID, LEFT_ID, found("LEFT", 75, 80))   # LEFT reads
            rig.clock.t = 1.2
            rig.nodes(RIGHT_ID)                                   # turn handed over
            rig.clock.t = 1.5
            rig.nodes(RIGHT_ID, RIGHT_ID, found("RIGHT", 75, 80))
            rig.log.close()
            with open(os.path.join(folder, "readings.csv"), newline="") as handle:
                text = handle.read()
            self.assertNotIn(MAC, text)
            rows = list(csv.DictReader(text.splitlines()))
            self.assertEqual([r["node_id"] for r in rows], [str(LEFT_ID), str(RIGHT_ID)])
            self.assertEqual(rows[1]["turn_ms"], "300.0")          # 1.5 - 1.2 s
            self.assertEqual(rows[0]["step"], "C-80")
            with open(os.path.join(folder, "turns.csv"), newline="") as handle:
                turns = list(csv.DictReader(handle))
            # The opening state, then the handover: LEFT off, RIGHT on.
            self.assertEqual([(t["node_id"], t["has_turn"]) for t in turns[-2:]],
                             [(str(LEFT_ID), "0"), (str(RIGHT_ID), "1")])


class ReportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.folder = build_run(cls.tmp.name)
        cls.loaded = ct.load_run(cls.folder)
        cls.result = ct.analyse(cls.loaded)
        cls.by_step = {r["step"].name: r for r in cls.result["steps"]}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_roles_from_the_control_spots(self):
        self.assertEqual(self.result["roles"], {LEFT_ID: "LEFT", RIGHT_ID: "RIGHT"})
        self.assertIn("control spot", self.result["how"])

    def test_roles_by_hand_win(self):
        roles, how = ct.infer_roles(self.loaded, left=RIGHT_ID, right=LEFT_ID)
        self.assertEqual(roles, {RIGHT_ID: "LEFT", LEFT_ID: "RIGHT"})
        self.assertEqual(how, "given by hand")

    def test_each_node_on_its_own(self):
        centre = self.by_step["C-80"]["nodes"]
        self.assertAlmostEqual(centre["LEFT"].x_med, 105, places=0)
        self.assertAlmostEqual(centre["RIGHT"].x_med, 70, places=0)
        self.assertEqual(centre["LEFT"].in_column_pct, 0)
        self.assertEqual(centre["RIGHT"].in_column_pct, 100)
        control = self.by_step["L-80"]["nodes"]
        self.assertEqual(control["RIGHT"].lost_pct, 100)
        self.assertEqual(control["RIGHT"].at_limit_pct, 100)
        self.assertAlmostEqual(control["LEFT"].angle_med, 90, places=1)

    def test_a_bounce_on_every_left_turn(self):
        game = self.by_step["C-80"]["game"]
        # 6 s of 1 s turns starting with LEFT: three LEFT turns, each one bounce.
        self.assertEqual(len(game.bounces), 3)
        for bounce in game.bounces:
            self.assertEqual(bounce.side, "right")
            self.assertEqual(bounce.turn_role, "LEFT")
            self.assertLessEqual(bounce.turn_ms, ct.HANDOVER_MS)
            self.assertTrue(bounce.cell_moved)
            self.assertAlmostEqual(bounce.duration, 1.0, places=6)
            self.assertTrue(bounce.before.startswith("LEFT found"))
        self.assertEqual(game.in_column_pct, 50)
        self.assertEqual(game.methods["tri"][1], 100)
        self.assertEqual(len(self.by_step["L-80"]["game"].bounces), 0)

    def test_findings(self):
        text = "\n".join(self.result["findings"])
        self.assertIn("the two nodes disagree", text)
        self.assertIn("135 cm apart", text)          # 100 + (105 - 70)
        self.assertIn("left the centre column 3 times", text)
        self.assertIn("LEFT 3", text)
        self.assertIn("'tri' did best", text)

    def test_report_and_plots_are_written(self):
        out = []
        self.assertEqual(ct.report(self.folder, out=out.append, plots=True), 0)
        self.assertTrue((self.folder / "report.md").exists())
        self.assertIn("## Findings", out[0])
        self.assertIn("## Bounces at C-80", out[0])
        try:
            import matplotlib  # noqa: F401
        except ImportError:
            return
        for name in ("L-80", "R-80", "C-80"):
            self.assertTrue((self.folder / f"plot-{name}.png").exists(), name)


class ReadinessTest(unittest.TestCase):
    """The checks before and during a run: a hidden game window sends its
    status about once a second instead of ten times, and a second page on the
    menu sends its own."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.rig = FakeRig(__import__("pathlib").Path(self.tmp.name))

    def tearDown(self):
        self.rig.log.close()
        self.tmp.cleanup()

    def statuses(self, seconds, every_s, screen="game"):
        start = self.rig.clock.t
        k = 0
        while k * every_s < seconds:
            self.rig.clock.t = round(start + k * every_s, 3)
            if screen == "game":
                self.rig.status(75, 75)
            else:
                self.rig.log.on_message({"type": "game:status", "screen": screen, "mode": "mouse",
                                         "status": "idle", "cursor": None})
            k += 1

    def test_a_visible_game_page_is_ready(self):
        self.statuses(3, 0.1)
        self.assertEqual(self.rig.log.problems(), [])

    def test_a_throttled_page_is_not(self):
        self.statuses(3, 1.0)
        problems = self.rig.log.problems()
        self.assertEqual(len(problems), 1)
        self.assertIn("updates a second instead of 10", problems[0])

    def test_only_a_page_on_the_menu(self):
        self.statuses(3, 0.1, screen="menu")
        self.assertIn("on the 'menu' screen", self.rig.log.problems()[0])

    def test_a_second_page_is_noted(self):
        self.statuses(3, 0.1)
        self.rig.log.on_message({"type": "game:status", "screen": "menu", "mode": "mouse",
                                 "status": "idle", "cursor": None})
        self.assertEqual(self.rig.log.problems(), [])
        self.assertIn("second game page", self.rig.log.notes()[0])


class MirroredRigTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.result = ct.analyse(ct.load_run(build_mirrored_run(cls.tmp.name)))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_the_direction_check_finds_it(self):
        self.assertEqual(self.result["sign"], -1)
        for name, game, other in self.result["direction"]:
            self.assertLess(other, 1, name)
        self.assertGreater(max(game for _, game, _ in self.result["direction"]), 150)
        self.assertIn("turn the other way", self.result["findings"][0])

    def test_the_readings_fall_short_by_the_body(self):
        text = "\n".join(self.result["findings"])
        self.assertIn(f"fell a median {ct.BODY_RADIUS_CM:.0f} cm short", text)
        self.assertIn("about what the game adds back", text)

    def test_node_numbers_use_the_direction_that_fits(self):
        centre = {r["step"].name: r for r in self.result["steps"]}["C-80"]["nodes"]
        for role in ct.ROLES:
            self.assertAlmostEqual(centre[role].x_med, 75, places=0)
            self.assertAlmostEqual(centre[role].angle_med, centre[role].angle_expected, places=0)
            self.assertTrue(centre[role].reachable)
        self.assertFalse(any("two nodes disagree" in text for text in self.result["findings"]))


class HiddenGamePageTest(unittest.TestCase):
    def test_too_few_samples_is_said_and_not_read_as_no_bounces(self):
        with tempfile.TemporaryDirectory() as folder:
            result = ct.analyse(ct.load_run(build_run(folder, status_every=20)))
            text = "\n".join(result["findings"])
            self.assertIn("sent too little", text)
            self.assertIn("C-80 (3 of ~60)", text)
            self.assertNotIn("never left", text)
            self.assertIn("No usable game samples in the centre spots", text)


if __name__ == "__main__":
    unittest.main()
