"""
chain_replay.py - replay one session through the V1 and V2 filtering chains.

V1, as it ran in the browser (game.js): a node message only replaced that
node's latest value; the rules ran once per ANIMATION FRAME (~60 Hz) on the
latest values, so every frame re-saw the same reading until the next one
arrived. Per frame: each channel filter is fed the latest raw value, the
proximity alert counts frames (not readings) on the raw values, and the cell
vote and the bad-reading streak only advance on a frame that followed a new
message. Built from the filterRules.py stages, so there is one copy of each
rule; only the call pattern differs.

V2, as serverFilter.py runs it: the chain runs once per fresh reading, only
the reporting sensor's channel is fed, and tracking.py's constant-velocity
predictor gets the same raw reading (prediction only).

Both produce a ChainTrace: one step per evaluation (frame or reading) with
the filtered distance per sensor, the status and the displayed cell.

Standard library only.
"""

from __future__ import annotations

import math
import os
import sys
from dataclasses import dataclass, field
from typing import Optional

WEBSITE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if WEBSITE_DIR not in sys.path:
    sys.path.insert(0, WEBSITE_DIR)

from filterRules import (  # noqa: E402
    GRID_SIZE,
    STATUS_OK,
    STATUS_OUT_OF_BOUNDS,
    STATUS_TOO_CLOSE,
    CellStabiliser,
    ChannelFilter,
    CoordinatePipeline,
    FilterConfig,
    PlayArea,
    ProximityGuard,
    StreakHold,
    UltrasonicArrayGeometry,
)
from serverFilter import ServerFilterStage  # noqa: E402

# Browser animation frame rate V1 ran at, Hz. requestAnimationFrame follows
# the display refresh; 60 Hz is the common monitor rate (the V1 baseline found
# 60, 120 and 144 Hz fitting different sessions, so it is a CLI option).
DEFAULT_V1_FRAME_HZ = 60.0

# Offset of the first animation frame after the first reading, ms. Zero puts
# a frame exactly on the first reading's time; frames run before a reading
# only if strictly earlier, as a frame cannot see a message not yet arrived.
DEFAULT_V1_FRAME_PHASE_MS = 0.0

MS_PER_SECOND = 1000.0


@dataclass
class ChainTrace:
    """One chain's output over a session. Step k is one evaluation."""

    name: str
    t_ms: list = field(default_factory=list)
    filtered_cm: list = field(default_factory=list)    # per step: [L, C, R], None = none
    status: list = field(default_factory=list)
    cell: list = field(default_factory=list)            # per step: (gx, gy) or None
    predicted_cm: Optional[list] = None                 # V2 only: per step [L, C, R]
    rejected: list = field(default_factory=list)        # slew-gate rejects per channel, final

    def append(self, t_ms, filtered, status, cell, predicted=None) -> None:
        self.t_ms.append(t_ms)
        self.filtered_cm.append(list(filtered))
        self.status.append(status)
        self.cell.append(cell)
        if self.predicted_cm is not None:
            self.predicted_cm.append(list(predicted))


# =============================================================================
# V1: the browser chain, once per animation frame
# =============================================================================

class V1FrameChain:
    """The V1 browser call pattern over the filterRules stages."""

    def __init__(self, area: PlayArea, config: Optional[FilterConfig] = None):
        self.config = config or FilterConfig()
        self.area = area
        self.channels = [ChannelFilter(self.config) for _ in range(GRID_SIZE)]
        self.geometry = UltrasonicArrayGeometry()
        self.guard = ProximityGuard(self.config)
        self.stabiliser = CellStabiliser(self.config)
        self.hold = StreakHold(self.config)
        self.latest = [None] * GRID_SIZE
        self._new_since_frame = False
        self._held_cell: Optional[tuple] = None
        self._last_ok_ms = -math.inf

    def on_reading(self, slot: int, distance_cm: Optional[float]) -> None:
        """A node message arrives: it only replaces that node's latest value."""
        self.latest[slot] = distance_cm
        self._new_since_frame = True

    def frame(self, now_ms: float) -> tuple:
        """One animation frame. Returns (status, cell, filtered)."""
        raw = self.geometry.channels(self.latest)
        is_new, self._new_since_frame = self._new_since_frame, False
        filtered = [ch.update(v, now_ms) for ch, v in zip(self.channels, raw)]

        # The alert reads RAW values, but confirms over FRAMES, not readings.
        nearest = self.geometry.nearest_raw_cm(raw)
        if self.guard.update(nearest, self.area.alert_threshold_cm):
            self.hold.reset()
            self._held_cell = None
            return STATUS_TOO_CLOSE, None, filtered

        fix = self.geometry.locate(filtered, self.area, self.config)
        cell = None
        if fix.status == STATUS_OK and self.area.contains(fix.column, fix.distance_cm):
            previous_row = (self._held_cell[1] if self._held_cell
                            and self._held_cell[0] == fix.column else None)
            cell = (fix.column, self.area.row_for(fix.column, fix.distance_cm, previous_row))

        if cell is not None:
            self.hold.record(True)
            # The vote only advances on a frame that followed a new message.
            shown = (self.stabiliser.vote(*cell) if is_new
                     else self.stabiliser.cell or cell)
            self._held_cell = shown
            self._last_ok_ms = now_ms
            return STATUS_OK, shown, filtered

        if is_new:
            self.hold.record(False)
        within_timeout = now_ms - self._last_ok_ms <= self.config.hold_timeout_ms
        if self._held_cell is not None and self.hold.keep_holding() and within_timeout:
            return STATUS_OK, self._held_cell, filtered
        self._held_cell = None
        status = STATUS_OUT_OF_BOUNDS if fix.status == STATUS_OK else fix.status
        return status, None, filtered


def replay_v1(readings: list, area: PlayArea,
              frame_hz: float = DEFAULT_V1_FRAME_HZ,
              phase_ms: float = DEFAULT_V1_FRAME_PHASE_MS,
              config: Optional[FilterConfig] = None) -> ChainTrace:
    """Replay readings through V1: frames every 1/frame_hz from the first
    reading to one frame after the last; a reading is delivered after every
    frame strictly before its time."""
    if frame_hz <= 0:
        raise ValueError("frame_hz must be positive")
    trace = ChainTrace("V1")
    if not readings:
        return trace
    chain = V1FrameChain(area, config)
    period_ms = MS_PER_SECOND / frame_hz
    start_ms = readings[0].t_ms + phase_ms
    end_ms = readings[-1].t_ms + period_ms
    frame_index = 0

    def frame_time(index):
        return start_ms + index * period_ms

    def run_frame(t_ms):
        status, cell, filtered = chain.frame(t_ms)
        trace.append(t_ms, filtered, status, cell)

    for reading in readings:
        while frame_time(frame_index) < reading.t_ms:
            run_frame(frame_time(frame_index))
            frame_index += 1
        chain.on_reading(reading.slot, reading.distance_cm)
    while frame_time(frame_index) <= end_ms:
        run_frame(frame_time(frame_index))
        frame_index += 1
    trace.rejected = [ch.reject_count for ch in chain.channels]
    return trace


# =============================================================================
# V2: serverFilter.py, once per fresh reading
# =============================================================================

def replay_v2(readings: list, area: PlayArea,
              config: Optional[FilterConfig] = None) -> ChainTrace:
    """Replay readings through ServerFilterStage, slots 0, 1, 2 = L, C, R."""
    trace = ChainTrace("V2", predicted_cm=[])
    pipeline = CoordinatePipeline(UltrasonicArrayGeometry(), area=area, config=config)
    stage = ServerFilterStage(pipeline=pipeline)
    stage.assign_slots(list(range(GRID_SIZE)))
    for reading in readings:
        result = stage.on_reading(reading.slot, reading.distance_cm, reading.t_ms)
        cell = (result.gx, result.gy) if result.has_cell else None
        trace.append(reading.t_ms, result.filtered, result.status, cell, stage.predicted_cm)
    trace.rejected = list(pipeline.rejected)
    return trace


# =============================================================================
# Counts
# =============================================================================

def count_cell_changes(cells: list) -> int:
    """Changes of the displayed cell between consecutive steps that both show
    a cell (the V1 baseline's definition: a gap with no cell is not a change)."""
    return sum(1 for a, b in zip(cells, cells[1:])
               if a is not None and b is not None and a != b)


def count_alarm_episodes(statuses: list) -> int:
    """Runs of too-close: each entry into the alarm state is one episode."""
    return sum(1 for k, status in enumerate(statuses)
               if status == STATUS_TOO_CLOSE and (k == 0 or statuses[k - 1] != STATUS_TOO_CLOSE))


def area_for(per_column: Optional[tuple]) -> PlayArea:
    """The calibrated play area, or the default one. PlayArea.calibrated()
    itself falls back to the default for a too-shallow column."""
    return PlayArea.calibrated(per_column) if per_column else PlayArea.default()
