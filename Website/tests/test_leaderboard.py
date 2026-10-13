"""Tests for leaderboard.py and app.py's /api/leaderboard.

Run from Website/ with:

    python -m unittest tests.test_leaderboard
"""

import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from leaderboard import KEEP_ENTRIES, Leaderboard, LeaderboardError, clean_name  # noqa: E402


class LeaderboardTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "leaderboard.json"
        self.board = Leaderboard(self.path)

    def tearDown(self):
        self.dir.cleanup()

    def test_no_file_is_an_empty_leaderboard(self):
        self.assertEqual(self.board.top(), [])

    def test_saves_to_the_json_file_and_reads_it_back(self):
        saved = self.board.add("Ada", 12, 3, "random", now=100)
        self.assertEqual(saved["entry"]["rank"], 1)
        self.assertEqual(saved["total"], 1)
        on_disk = json.loads(self.path.read_text())
        self.assertEqual(on_disk, [{"name": "Ada", "score": 12, "level": 3, "board": "random", "at": 100.0}])
        # A fresh reader sees the same.
        self.assertEqual(Leaderboard(self.path).top()[0]["name"], "Ada")

    def test_ranked_by_score_then_level_then_who_was_first(self):
        self.board.add("Late", 10, 2, now=300)
        self.board.add("Low", 4, 1, now=100)
        self.board.add("High", 25, 5, now=200)
        self.board.add("Early", 10, 2, now=50)
        self.board.add("Higher level", 10, 3, now=400)
        names = [e["name"] for e in self.board.top()]
        self.assertEqual(names, ["High", "Higher level", "Early", "Late", "Low"])
        self.assertEqual([e["rank"] for e in self.board.top()], [1, 2, 3, 4, 5])

    def test_add_reports_the_new_entry_rank(self):
        self.board.add("A", 30, 4, now=1)
        self.board.add("B", 10, 2, now=2)
        saved = self.board.add("C", 20, 3, now=3)
        self.assertEqual(saved["entry"]["rank"], 2)
        self.assertEqual(saved["total"], 3)

    def test_top_limits(self):
        for i in range(15):
            self.board.add(f"P{i}", i, 1, now=i)
        self.assertEqual(len(self.board.top()), 10)
        self.assertEqual(len(self.board.top(3)), 3)
        self.assertEqual(self.board.top(1)[0]["name"], "P14")

    def test_names_are_cleaned(self):
        self.assertEqual(clean_name("  Mole   Whacker  "), "Mole Whacker")
        self.assertEqual(clean_name("a\nb\tc\x00"), "a b c")
        self.assertEqual(len(clean_name("x" * 40)), 16)
        for bad in ["", "   ", "\n\t", None, 12]:
            with self.assertRaises(LeaderboardError):
                clean_name(bad)

    def test_bad_numbers_are_refused(self):
        for score, level in [(-1, 1), (1.5, 1), ("10", 1), (True, 1), (5, 0), (5, 11), (None, 1), (5, None)]:
            with self.assertRaises(LeaderboardError, msg=(score, level)):
                self.board.add("Ada", score, level)
        self.assertEqual(self.board.top(), [])

    def test_unknown_board_counts_as_classic(self):
        self.board.add("Ada", 5, 1, board="hexagons", now=1)
        self.assertEqual(self.board.top()[0]["board"], "classic")

    def test_a_damaged_file_is_survived(self):
        self.path.write_text("{ not json")
        self.assertEqual(self.board.top(), [])
        self.board.add("Ada", 5, 1, now=1)
        self.assertEqual(len(self.board.top()), 1)

    def test_hand_edited_bad_entries_are_skipped(self):
        self.path.write_text(json.dumps([
            {"name": "Good", "score": 5, "level": 2, "board": "random", "at": 1},
            {"name": "", "score": 9, "level": 2},
            {"score": 9, "level": 2},
            {"name": "Neg", "score": -4, "level": 2},
            "nonsense",
        ]))
        self.assertEqual([e["name"] for e in self.board.top()], ["Good"])

    def test_only_the_best_are_kept(self):
        entries = [{"name": f"P{i}", "score": i, "level": 1, "board": "classic", "at": i} for i in range(KEEP_ENTRIES)]
        self.path.write_text(json.dumps(entries))
        self.board.add("Worst", 0, 1, now=10**9)
        on_disk = json.loads(self.path.read_text())
        self.assertEqual(len(on_disk), KEEP_ENTRIES)
        self.assertNotIn("Worst", [e["name"] for e in on_disk])

    def test_saves_at_once_lose_nothing(self):
        threads = [threading.Thread(target=self.board.add, args=(f"P{i}", i, 1)) for i in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(json.loads(self.path.read_text())), 20)
        # No temporary files left behind.
        self.assertEqual([p.name for p in Path(self.dir.name).iterdir()], ["leaderboard.json"])


class LeaderboardApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import app  # noqa: E402 - needs flask, websockets and numpy
        cls.app = app

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.saved = self.app.leaderboard
        self.app.leaderboard = Leaderboard(Path(self.dir.name) / "leaderboard.json")
        self.client = self.app.app.test_client()

    def tearDown(self):
        self.app.leaderboard = self.saved
        self.dir.cleanup()

    def test_get_starts_empty(self):
        response = self.client.get("/api/leaderboard")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"entries": []})

    def test_post_saves_and_answers_with_rank_and_top(self):
        self.client.post("/api/leaderboard", json={"name": "Ada", "score": 30, "level": 6, "board": "random"})
        response = self.client.post("/api/leaderboard", json={"name": " Bo ", "score": 12, "level": 3, "board": "classic"})
        self.assertEqual(response.status_code, 201)
        body = response.get_json()
        self.assertEqual(body["entry"]["name"], "Bo")
        self.assertEqual(body["entry"]["rank"], 2)
        self.assertEqual(body["total"], 2)
        self.assertEqual([e["name"] for e in body["entries"]], ["Ada", "Bo"])

        listed = self.client.get("/api/leaderboard?limit=1").get_json()["entries"]
        self.assertEqual([(e["rank"], e["name"], e["score"], e["level"]) for e in listed], [(1, "Ada", 30, 6)])

    def test_post_refuses_bad_input(self):
        for body in [{}, {"name": "", "score": 3, "level": 1}, {"name": "Ada", "score": -3, "level": 1},
                     {"name": "Ada", "score": 3, "level": 99}]:
            response = self.client.post("/api/leaderboard", json=body)
            self.assertEqual(response.status_code, 400, body)
            self.assertIn("error", response.get_json())
        response = self.client.post("/api/leaderboard", data="not json", content_type="text/plain")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get("/api/leaderboard").get_json()["entries"], [])

    def test_get_limit_is_kept_sensible(self):
        for i in range(3):
            self.client.post("/api/leaderboard", json={"name": f"P{i}", "score": i + 1, "level": 1})
        self.assertEqual(len(self.client.get("/api/leaderboard?limit=0").get_json()["entries"]), 1)
        self.assertEqual(len(self.client.get("/api/leaderboard?limit=abc").get_json()["entries"]), 3)


if __name__ == "__main__":
    unittest.main()
