"""
session_readers.py - load one logged session of raw ultrasonic readings.

Two input formats, each behind a small adapter that yields the same plain
data: a time-ordered list of Reading(t_ms, slot, distance_cm), one per fresh
reading from one sensor, with None for a no echo (never 0 cm).

  * Simple CSV, one row per reading:

        t_s,sensor,raw_cm
        0.000,left,82.4
        0.020,centre,-1        <- -1, any negative value or empty = no echo

    sensor is left/centre/right (also center, L/C/R or 0/1/2).

  * The Sprint 1 game log CSV that the server writes at the end of a round
    (game-NNN-<date>.csv). One row per WebSocket broadcast; every row repeats
    the LATEST raw value of all three sensors, and `t` is the browser receive
    time in ms. The adapter turns it back into per-sensor readings: a sensor
    reported when its value changed from the previous row. Two equal readings
    in a row are indistinguishable from a repeat, so the reading count is a
    lower bound. If the paired game-NNN-<date>.json is next to the CSV and
    holds a completed calibration, its per-column (near, far) bounds are used.

Standard library only.
"""

from __future__ import annotations

import csv
import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

SLOT_NAMES = ("left", "centre", "right")
SLOT_ALIASES = {
    "left": 0, "l": 0, "0": 0,
    "centre": 1, "center": 1, "c": 1, "1": 1,
    "right": 2, "r": 2, "2": 2,
}

MS_PER_SECOND = 1000.0

SIMPLE_COLUMNS = ("t_s", "sensor", "raw_cm")
GAME_LOG_TIME_COLUMN = "t"                  # browser receive time, ms
GAME_LOG_RAW_COLUMN = "{slot}_raw_cm"       # one per slot name


@dataclass(frozen=True)
class Reading:
    """One fresh reading from one sensor. distance_cm None = no echo."""

    t_ms: float
    slot: int
    distance_cm: Optional[float]


@dataclass
class Session:
    """A replayable session: readings in time order, plus the calibrated
    (near_cm, far_cm) per column if the log carried one."""

    source: str                                   # file name only, never a path
    readings: list
    per_column: Optional[tuple] = None
    notes: list = field(default_factory=list)     # data-quality notes

    @property
    def duration_s(self) -> float:
        if len(self.readings) < 2:
            return 0.0
        return (self.readings[-1].t_ms - self.readings[0].t_ms) / MS_PER_SECOND

    def count_per_slot(self) -> list:
        counts = [0] * len(SLOT_NAMES)
        for reading in self.readings:
            counts[reading.slot] += 1
        return counts

    def no_echo_per_slot(self) -> list:
        counts = [0] * len(SLOT_NAMES)
        for reading in self.readings:
            if reading.distance_cm is None:
                counts[reading.slot] += 1
        return counts


# =============================================================================
# Value helpers
# =============================================================================

def parse_distance_cm(text) -> Optional[float]:
    """A distance in cm, or None for no echo: empty, negative, non-finite
    or unparseable. A negative reading is missing, never 0 cm."""
    if text is None:
        return None
    text = str(text).strip()
    if not text:
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    if not math.isfinite(value) or value < 0:
        return None
    return value


def parse_slot(text) -> int:
    key = str(text).strip().lower()
    if key not in SLOT_ALIASES:
        raise ValueError(f"unknown sensor '{text}'; use one of {', '.join(SLOT_NAMES)}")
    return SLOT_ALIASES[key]


def _sorted_by_time(readings: list) -> tuple:
    """Stable sort by time; returns (readings, how many were out of order)."""
    out_of_order = sum(1 for a, b in zip(readings, readings[1:]) if b.t_ms < a.t_ms)
    return sorted(readings, key=lambda r: r.t_ms), out_of_order


# =============================================================================
# Adapters
# =============================================================================

def read_simple_csv(path) -> Session:
    """t_s, sensor, raw_cm; one row per reading. Lines starting with # are
    comments. Rows with no usable time or sensor are skipped and noted."""
    path = Path(path)
    readings, skipped = [], 0
    with open(path, encoding="utf-8", newline="") as handle:
        rows = csv.DictReader(line for line in handle if not line.lstrip().startswith("#"))
        for row in rows:
            try:
                t_s = float(row["t_s"])
                slot = parse_slot(row["sensor"])
            except (KeyError, TypeError, ValueError):
                skipped += 1
                continue
            if not math.isfinite(t_s):
                skipped += 1
                continue
            readings.append(Reading(t_s * MS_PER_SECOND, slot, parse_distance_cm(row.get("raw_cm"))))
    readings, out_of_order = _sorted_by_time(readings)
    notes = []
    if skipped:
        notes.append(f"{skipped} rows without a usable time or sensor skipped")
    if out_of_order:
        notes.append(f"{out_of_order} rows out of time order (sorted)")
    return Session(path.name, readings, None, notes)


def read_game_log_csv(path) -> Session:
    """Adapter for the Sprint 1 game log CSV (see the module docstring)."""
    path = Path(path)
    readings, skipped = [], 0
    previous = [None] * len(SLOT_NAMES)
    first_row = True
    with open(path, encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            try:
                t_ms = float(row[GAME_LOG_TIME_COLUMN])
            except (KeyError, TypeError, ValueError):
                skipped += 1
                continue
            if not math.isfinite(t_ms):
                skipped += 1
                continue
            for slot, name in enumerate(SLOT_NAMES):
                value = parse_distance_cm(row.get(GAME_LOG_RAW_COLUMN.format(slot=name)))
                # A row repeats every sensor's latest value, so only a change
                # is a new reading. The first row has nothing to repeat.
                if (value is not None) if first_row else (value != previous[slot]):
                    readings.append(Reading(t_ms, slot, value))
                previous[slot] = value
            first_row = False
    readings, out_of_order = _sorted_by_time(readings)
    notes = ["game log: a reading is a change of a sensor's latest value; "
             "equal consecutive readings are invisible, so counts are lower bounds"]
    if skipped:
        notes.append(f"{skipped} rows without a usable time skipped")
    if out_of_order:
        notes.append(f"{out_of_order} readings out of time order (sorted)")
    per_column = read_game_log_calibration(path.with_suffix(".json"))
    notes.append("calibration: from the paired JSON" if per_column
                 else "calibration: none in a paired JSON, default play area")
    return Session(path.name, readings, per_column, notes)


def read_game_log_calibration(json_path) -> Optional[tuple]:
    """(near_cm, far_cm) per column from a game log JSON's completed
    calibration, or None if the file, the flag or any bound is missing."""
    json_path = Path(json_path)
    if not json_path.exists():
        return None
    try:
        with open(json_path, encoding="utf-8") as handle:
            calibration = (json.load(handle) or {}).get("calibration") or {}
    except (OSError, ValueError):
        return None
    if not calibration.get("calibrated"):
        return None
    columns = []
    for column in calibration.get("perColumn") or []:
        near = parse_distance_cm((column or {}).get("near"))
        far = parse_distance_cm((column or {}).get("far"))
        if near is None or far is None:
            return None
        columns.append((near, far))
    return tuple(columns) if len(columns) == len(SLOT_NAMES) else None


def read_session(path) -> Session:
    """Pick the adapter from the CSV header."""
    path = Path(path)
    with open(path, encoding="utf-8", newline="") as handle:
        header_line = ""
        for line in handle:
            if line.strip() and not line.lstrip().startswith("#"):
                header_line = line
                break
    header = {name.strip() for name in next(csv.reader([header_line]), [])}
    if set(SIMPLE_COLUMNS) <= header:
        return read_simple_csv(path)
    game_columns = {GAME_LOG_TIME_COLUMN} | {GAME_LOG_RAW_COLUMN.format(slot=s) for s in SLOT_NAMES}
    if game_columns <= header:
        return read_game_log_csv(path)
    raise ValueError(f"{path.name}: not a simple reading CSV ({', '.join(SIMPLE_COLUMNS)}) "
                     "or a game log CSV")
