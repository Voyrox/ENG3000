"""The game's leaderboard, kept in leaderboard.json next to this file.

Every saved round is one entry: the player's name, their score, the level they
reached, the board they played (classic or random) and when. The file is a
plain JSON list, so it can be read, backed up or cleared by hand; delete it to
start the leaderboard again.

app.py serves it at /api/leaderboard (GET the top scores, POST a new one).
Writes go to a temporary file first and are then swapped in, so a crash
mid-write never leaves a half-written leaderboard, and a lock keeps two saves
at once from losing one another.
"""

import json
import os
import tempfile
import threading
import time
from pathlib import Path

DEFAULT_PATH = Path(__file__).resolve().parent / "leaderboard.json"

NAME_MAX = 16
SCORE_MAX = 100000
LEVEL_MAX = 10          # game.js MAX_LEVEL
BOARDS = ("classic", "random")
KEEP_ENTRIES = 500      # only the best this many are kept, so the file stays small
TOP_DEFAULT = 10


class LeaderboardError(ValueError):
    """A score that cannot be saved; the message says why."""


def clean_name(name):
    """The name as it is saved: printable characters only, spaces collapsed,
    at most NAME_MAX long. Raises LeaderboardError if nothing is left."""
    if not isinstance(name, str):
        raise LeaderboardError("name must be text")
    # Tabs and line breaks become spaces; anything else unprintable goes.
    printable = "".join(" " if ch.isspace() else ch for ch in name if ch.isspace() or ch.isprintable())
    cleaned = " ".join(printable.split())[:NAME_MAX].strip()
    if not cleaned:
        raise LeaderboardError("enter a name")
    return cleaned


def _whole_number(value, field, low, high):
    # bool is an int in Python; true/false is never a score.
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value):
        raise LeaderboardError(f"{field} must be a whole number")
    value = int(value)
    if not low <= value <= high:
        raise LeaderboardError(f"{field} must be between {low} and {high}")
    return value


def _rank_key(entry):
    # Highest score first, then the higher level, then whoever got there first.
    return (-entry["score"], -entry["level"], entry["at"])


class Leaderboard:
    def __init__(self, path=DEFAULT_PATH):
        self.path = Path(path)
        self._lock = threading.Lock()

    def _read(self):
        """Every entry in the file, best first. A missing, empty or damaged
        file is an empty leaderboard rather than an error."""
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError):
            return []
        entries = []
        for item in data if isinstance(data, list) else []:
            try:
                entries.append({
                    "name": clean_name(item["name"]),
                    "score": _whole_number(item["score"], "score", 0, SCORE_MAX),
                    "level": _whole_number(item["level"], "level", 1, LEVEL_MAX),
                    "board": item.get("board") if item.get("board") in BOARDS else "classic",
                    "at": float(item.get("at", 0)),
                })
            except (KeyError, TypeError, ValueError):
                continue  # skip an entry edited into something unreadable
        return sorted(entries, key=_rank_key)

    def _write(self, entries):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".leaderboard-", suffix=".json", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(entries, f, indent=2, ensure_ascii=False)
                f.write("\n")
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def top(self, limit=TOP_DEFAULT):
        """The best `limit` entries, each with its rank (1 = best)."""
        with self._lock:
            entries = self._read()
        return [dict(entry, rank=i + 1) for i, entry in enumerate(entries[:limit])]

    def add(self, name, score, level, board="classic", now=None):
        """Save one round. Returns the saved entry with its rank, and how many
        entries there are. Raises LeaderboardError for a bad name or numbers."""
        entry = {
            "name": clean_name(name),
            "score": _whole_number(score, "score", 0, SCORE_MAX),
            "level": _whole_number(level, "level", 1, LEVEL_MAX),
            "board": board if board in BOARDS else "classic",
            "at": time.time() if now is None else float(now),
        }
        with self._lock:
            entries = self._read()
            entries.append(entry)
            entries.sort(key=_rank_key)
            rank = next(i for i, e in enumerate(entries) if e is entry) + 1
            total = len(entries)
            self._write(entries[:KEEP_ENTRIES])
        return {"entry": dict(entry, rank=rank), "total": total}
