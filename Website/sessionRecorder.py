"""
sessionRecorder.py - record every raw scanner-node reading to a CSV file.

Off unless the server is started with REC=1:

    REC=1 python Website/app.py

Each run writes logs/raw-YYYYmmdd-HHMMSS.csv at the repository root (/logs is
gitignored): one row per JSON line a node sends, as the server received it and
before any filtering. tools/bench_noise.py turns a recording into noise,
outlier and dropout numbers.

Columns:
  t_s            server receive time, seconds from the start of the recording
  label          what the bench test is measuring (e.g. p3-60cm), set over
                 HTTP; empty between steps
  node_id        the server's id for the node
  role           LEFT / RIGHT from the calibration screen; empty until assigned
  has_turn       1 if the node held the scan turn, 0 if not
  ms_since_turn  ms since the node was granted its turn; empty without one
  pulses         the multi-pulse setting (1 = off)
  left_cm, right_cm, avg_cm   as sent; -1 = no echo
  angle_deg, scan_state       as sent
A field the node did not send is left empty. The MAC the nodes send is never
written: the repository is public.

Standard library only.
"""

from __future__ import annotations

import csv
import math
import re
import threading
import time
from datetime import datetime
from pathlib import Path

COLUMNS = (
    "t_s", "label", "node_id", "role", "has_turn", "ms_since_turn", "pulses",
    "left_cm", "right_cm", "avg_cm", "angle_deg", "scan_state",
)

# Payload key for each measured column.
PAYLOAD_FIELDS = (
    ("left_cm", "left"),
    ("right_cm", "right"),
    ("avg_cm", "avg"),
    ("angle_deg", "angle"),
    ("scan_state", "scanState"),
)

LABEL_MAX_LENGTH = 40
_LABEL_DISALLOWED = re.compile(r"[^A-Za-z0-9._-]")

# The repository root's logs/, which .gitignore already covers.
DEFAULT_DIRECTORY = Path(__file__).resolve().parent.parent / "logs"


def recording_enabled(environ):
    return environ.get("REC") == "1"


def clean_label(label):
    """A label safe for a file name or a spreadsheet: letters, digits, . _ -"""
    if label is None:
        return ""
    return _LABEL_DISALLOWED.sub("", str(label))[:LABEL_MAX_LENGTH]


def format_number(value):
    """A payload number as text, or "" if it is missing or not a number."""
    if isinstance(value, bool) or value is None:
        return ""
    if isinstance(value, str):
        try:
            value = float(value)
        except ValueError:
            return ""
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and math.isfinite(value):
        return str(int(value)) if value.is_integer() else f"{value:.2f}"
    return ""


class SessionRecorder:
    """Appends one row per node reading to a CSV file.

    Rows come from the node threads and labels from the Flask thread, so both
    go through one lock. Every row is flushed straight away, so a crash or a
    Ctrl+C keeps everything recorded up to then.
    """

    def __init__(self, path, clock=time.monotonic):
        self.path = Path(path)
        self._clock = clock
        self._lock = threading.Lock()
        self._label = ""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._file = open(self.path, "w", newline="", encoding="utf-8")
        self._writer = csv.writer(self._file)
        self._writer.writerow(COLUMNS)
        self._file.flush()
        self._started = clock()

    @classmethod
    def from_env(cls, environ, directory=DEFAULT_DIRECTORY, clock=time.monotonic, now=None):
        """A recorder writing to a new timestamped file if REC=1, else None."""
        if not recording_enabled(environ):
            return None
        stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
        return cls(Path(directory) / f"raw-{stamp}.csv", clock=clock)

    @property
    def label(self):
        with self._lock:
            return self._label

    def set_label(self, label):
        """Label the rows recorded from now on. Returns the cleaned label."""
        with self._lock:
            self._label = clean_label(label)
            return self._label

    def record(self, node_id, payload, role=None, has_turn=False, ms_since_turn=None,
               pulses=None, received_at=None):
        """One reading. `received_at` is a time.monotonic() value (default: now).
        A line with none of the measured fields (the handshake) is skipped."""
        at = self._clock() if received_at is None else received_at
        measured = [format_number(payload.get(key)) for _, key in PAYLOAD_FIELDS]
        if not any(measured):
            return
        with self._lock:
            if self._file.closed:
                return
            self._writer.writerow([
                f"{at - self._started:.3f}",
                self._label,
                node_id,
                role or "",
                1 if has_turn else 0,
                "" if ms_since_turn is None else f"{ms_since_turn:.0f}",
                "" if pulses is None else pulses,
                *measured,
            ])
            self._file.flush()

    def close(self):
        with self._lock:
            self._file.close()
