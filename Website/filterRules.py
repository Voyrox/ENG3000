"""
filterRules.py - the sensor filtering rules as a standalone pipeline.

Ports the conditioning, safety, geometry, vote and hold rules that currently
live in public/displays/game.js (plus the row mapping from
callibrate_corners.js and the alert threshold from alert.js) into Python, so
the filtered coordinate can be computed once on the server and sent to every
client, instead of being recomputed in each browser tab.

NOT YET WIRED INTO app.py. See "Filtering pipeline" in the root README for the
integration steps.

Pipeline, in order:

    sample ──► Geometry.channels() ──► raw channels
                                          │
                                          ├─► ProximityGuard   (RAW readings)
                                          │
                                          ▼
                                   ChannelFilter per channel
                                   (slew gate -> median -> hold)
                                          │
                                          ▼
                                   Geometry.locate() ──► (x_cm, y_cm, column)
                                          │
                                          ▼
                                   PlayArea.row_for() ──► raw cell
                                          │
                                          ▼
                                   CellStabiliser (majority vote)
                                          │
                                          ▼
                                   HoldPolicy (ride out bad readings)
                                          │
                                          ▼
                                   FilteredCoordinate

Geometry is the swappable part. UltrasonicArrayGeometry reproduces today's
three-sensor rig; CartesianGeometry accepts an (x, y) position directly, which
is the entry point for the servo scanning rig in src/scanning.cpp once it
reports a position. Everything downstream of Geometry is shared.

Coordinates follow the project convention: x runs left to right across the
play area, y is depth from the screen, and grid cell (0, 0) is bottom-left -
nearest the screen, on the left - with (2, 2) top-right.

Standard library only. Run the tests with:

    python -m unittest discover -s Website/tests
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from collections import deque
from dataclasses import dataclass, field
from typing import Optional, Sequence

GRID_SIZE = 3

STATUS_OK = "ok"
STATUS_TOO_CLOSE = "too-close"
STATUS_NO_SIGNAL = "no-signal"
STATUS_OUT_OF_BOUNDS = "out-of-bounds"


# =============================================================================
# Configuration
# =============================================================================

@dataclass(frozen=True)
class FilterConfig:
    """Every tunable in the pipeline. Defaults match game.js on main."""

    # Per-channel conditioning (SENSOR_HISTORY, SENSOR_HOLD_MS)
    median_window: int = 5
    hold_ms: float = 350.0

    # Slew gate (MAX_SPEED_CM_PER_S, SLEW_*)
    max_speed_cm_per_s: float = 300.0
    slew_min_jump_cm: float = 25.0
    slew_max_jump_cm: float = 40.0
    relock_readings: int = 8
    relock_spread_cm: float = 20.0
    anchor_ttl_ms: float = 3000.0

    # Geometry (COLUMN_MARGIN_CM)
    column_margin_cm: float = 8.0

    # Safety (TOO_CLOSE_FRAMES)
    too_close_frames: int = 2

    # Cell vote (tuning.cellWindow, tuning.cellVotes)
    cell_window: int = 25
    cell_votes: int = 13

    # Hold and recovery (tuning.holdReadings, tuning.holdTimeoutMs)
    hold_readings: int = 100
    hold_timeout_ms: float = 5000.0

    def __post_init__(self):
        # A rival cell needing half the window or fewer lets two cells trade
        # the lead, which is the cursor flicker the vote exists to prevent.
        if self.cell_votes <= self.cell_window / 2:
            raise ValueError(
                f"cell_votes ({self.cell_votes}) must exceed half of "
                f"cell_window ({self.cell_window})")
        if self.cell_votes > self.cell_window:
            raise ValueError("cell_votes cannot exceed cell_window")


@dataclass(frozen=True)
class PlayArea:
    """Calibrated play-area bounds. Mirrors getBounds() in callibrate_corners.js.

    per_column holds (near_cm, far_cm) for each of the three columns. Use
    PlayArea.default() before calibration and PlayArea.calibrated() after.
    """

    per_column: tuple = ((20.0, 140.0),) * GRID_SIZE
    is_calibrated: bool = False
    width_cm: float = 150.0

    EDGE_MARGIN_CM = 15.0
    ABSOLUTE_ALERT_CM = 10.0
    ABSOLUTE_MAX_CM = 150.0
    BAND_HYSTERESIS_CM = 6.0
    MIN_PLAY_DEPTH_CM = 15.0

    @classmethod
    def default(cls) -> "PlayArea":
        return cls()

    @classmethod
    def calibrated(cls, per_column: Sequence[tuple], width_cm: float = 150.0) -> "PlayArea":
        """Build from six captured points. Falls back to defaults if any column
        is shallower than MIN_PLAY_DEPTH_CM, exactly as getBounds() does."""
        columns = tuple((float(n), float(f)) for n, f in per_column)
        if len(columns) != GRID_SIZE:
            raise ValueError(f"need {GRID_SIZE} columns, got {len(columns)}")
        if any(not (far - near >= cls.MIN_PLAY_DEPTH_CM) for near, far in columns):
            return cls(width_cm=width_cm)
        return cls(per_column=columns, is_calibrated=True, width_cm=width_cm)

    @property
    def near_cm(self) -> float:
        return min(near for near, _ in self.per_column)

    @property
    def far_cm(self) -> float:
        return max(far for _, far in self.per_column)

    @property
    def alert_threshold_cm(self) -> float:
        """Distance below which the player is too close (getAlertThresholdCm)."""
        if not self.is_calibrated:
            return self.ABSOLUTE_ALERT_CM
        return max(self.ABSOLUTE_ALERT_CM, self.near_cm - self.EDGE_MARGIN_CM)

    @property
    def max_cm(self) -> float:
        """Distance beyond which the reading is off the back (maxCoordCm)."""
        if not self.is_calibrated:
            return self.ABSOLUTE_MAX_CM
        return min(self.ABSOLUTE_MAX_CM, self.far_cm + self.EDGE_MARGIN_CM)

    def contains(self, column: int, distance_cm: float) -> bool:
        """isWithinPlayArea(): is this distance inside that column's span?"""
        if not isinstance(column, int) or not 0 <= column < GRID_SIZE:
            return False
        if distance_cm is None or not math.isfinite(distance_cm):
            return False
        near, far = self.per_column[column]
        return near - self.EDGE_MARGIN_CM <= distance_cm <= far + self.EDGE_MARGIN_CM

    def row_for(self, column: int, distance_cm: float,
                previous_row: Optional[int] = None) -> int:
        """bandFor(): pick the row, with hysteresis around row boundaries."""
        near, far = self.per_column[column]
        row_depth = (far - near) / GRID_SIZE
        candidate = _clamp(int(math.floor((distance_cm - near) / row_depth)), 0, GRID_SIZE - 1)
        if previous_row is None or candidate == previous_row:
            return candidate
        boundary = near + row_depth * max(candidate, previous_row)
        if abs(distance_cm - boundary) < self.BAND_HYSTERESIS_CM:
            return previous_row
        return candidate

    def column_centre_cm(self, column: int) -> float:
        return (column + 0.5) * self.width_cm / GRID_SIZE

    def column_at(self, x_cm: float) -> int:
        return _clamp(int(math.floor(x_cm / (self.width_cm / GRID_SIZE))), 0, GRID_SIZE - 1)


# =============================================================================
# Result
# =============================================================================

@dataclass
class FilteredCoordinate:
    """What one update produces. to_dict() is shaped for a WebSocket payload."""

    status: str
    x_cm: Optional[float] = None
    y_cm: Optional[float] = None
    gx: Optional[int] = None
    gy: Optional[int] = None
    raw_gx: Optional[int] = None
    raw_gy: Optional[int] = None
    column: Optional[int] = None
    held: bool = False
    held_for: int = 0
    calibrated: bool = False
    raw: list = field(default_factory=list)
    filtered: list = field(default_factory=list)

    @property
    def has_cell(self) -> bool:
        return self.gx is not None and self.gy is not None

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "x": self.x_cm,
            "y": self.y_cm,
            "gx": self.gx,
            "gy": self.gy,
            "rawGx": self.raw_gx,
            "rawGy": self.raw_gy,
            "column": self.column,
            "held": self.held,
            "heldFor": self.held_for,
            "calibrated": self.calibrated,
            "raw": self.raw,
            "filtered": self.filtered,
        }


@dataclass
class Fix:
    """A located position before cell mapping. Produced by a Geometry."""

    status: str
    x_cm: Optional[float] = None
    y_cm: Optional[float] = None
    column: Optional[int] = None
    distance_cm: Optional[float] = None


# =============================================================================
# Stage 1 - per-channel conditioning
# =============================================================================

class ChannelFilter:
    """Slew gate, then median, then hold - for one scalar channel.

    Port of isPlausible() and conditionSensor() in game.js. Works on any
    channel measured in centimetres: a sensor distance today, or an x or y
    coordinate from a scanning rig.
    """

    def __init__(self, config: FilterConfig):
        self._cfg = config
        self.reset()

    def reset(self) -> None:
        self._samples: deque = deque(maxlen=self._cfg.median_window)
        self._rejects: deque = deque(maxlen=self._cfg.relock_readings)
        self.value: Optional[float] = None
        self._last_good_ms = -math.inf
        self._anchor: Optional[float] = None
        self._anchor_ms = -math.inf
        self.reject_count = 0

    def update(self, raw: Optional[float], now_ms: float) -> Optional[float]:
        # An impossible jump is treated exactly like a dropout: it never enters
        # the median window, so it cannot drag the value toward itself.
        if raw is not None and not self._plausible(raw, now_ms):
            raw = None

        if raw is not None:
            self._samples.append(raw)
            ordered = sorted(self._samples)
            self.value = ordered[len(ordered) // 2]
            self._last_good_ms = now_ms
            self._anchor = self.value
            self._anchor_ms = now_ms
            return self.value

        if now_ms - self._last_good_ms <= self._cfg.hold_ms:
            return self.value                  # coast through the dropout

        self._samples.clear()
        self.value = None
        return None

    def _plausible(self, raw: float, now_ms: float) -> bool:
        cfg = self._cfg
        if self._anchor is None or now_ms - self._anchor_ms > cfg.anchor_ttl_ms:
            self._rejects.clear()
            return True                        # no live belief to contradict

        dt_ms = max(1.0, now_ms - self._anchor_ms)
        allowed = min(cfg.slew_max_jump_cm,
                      max(cfg.slew_min_jump_cm, cfg.max_speed_cm_per_s * dt_ms / 1000.0))
        if abs(raw - self._anchor) <= allowed:
            self._rejects.clear()
            return True

        # Keep what we reject: if enough rejects agree with each other rather
        # than with the anchor, the anchor was the wrong one, so re-lock.
        self._rejects.append(raw)
        if (len(self._rejects) >= cfg.relock_readings
                and max(self._rejects) - min(self._rejects) <= cfg.relock_spread_cm):
            self._samples.clear()
            self._rejects.clear()
            return True

        self.reject_count += 1
        return False


# =============================================================================
# Stage 2 - safety
# =============================================================================

class ProximityGuard:
    """Too-close detection on RAW readings, confirmed over N consecutive frames.

    This must never be fed filtered values. A median window full of safe
    distances smooths away the very spike the alert exists to catch. The frame
    confirmation is what stops crosstalk between sensors raising false alarms.
    """

    def __init__(self, config: FilterConfig):
        self._frames = config.too_close_frames
        self._streak = 0

    def reset(self) -> None:
        self._streak = 0

    def update(self, nearest_raw_cm: Optional[float], threshold_cm: float) -> bool:
        close = (nearest_raw_cm is not None and math.isfinite(nearest_raw_cm)
                 and 0 <= nearest_raw_cm < threshold_cm)
        self._streak = self._streak + 1 if close else 0
        return self._streak >= self._frames


# =============================================================================
# Stage 3 - geometry (the swappable part)
# =============================================================================

class Geometry(ABC):
    """Turns raw sensor data into channels, and filtered channels into a Fix.

    Subclass this to support new hardware. Nothing else in the pipeline needs
    to change.
    """

    @property
    @abstractmethod
    def channel_count(self) -> int:
        """How many scalar channels this geometry filters."""

    @abstractmethod
    def channels(self, sample) -> list:
        """Split one raw sample into per-channel values (None for no reading)."""

    @abstractmethod
    def nearest_raw_cm(self, raw_channels: Sequence[Optional[float]]) -> Optional[float]:
        """The raw distance from the screen that the proximity guard checks."""

    @abstractmethod
    def locate(self, filtered: Sequence[Optional[float]], area: PlayArea,
               config: FilterConfig) -> Fix:
        """Resolve filtered channels to a position, or a non-ok status."""

    def nearest_column(self, filtered: Sequence[Optional[float]],
                       area: PlayArea) -> Optional[int]:
        """Best-guess column WITHOUT touching any state. Used while too close,
        when the column is reported but hysteresis must not advance."""
        return None

    def reset(self) -> None:
        """Clear any state carried between updates. Override if stateful."""


class UltrasonicArrayGeometry(Geometry):
    """Three forward-facing sensors on one line, one column each.

    Port of the column selection in readSensorCoordinate(): the nearest
    in-bounds sensor owns the column, a rival must be clearly nearer to steal
    it, and x is the centre of that column. x can only ever take three values
    here, because this rig cannot resolve position within a column.

    Sample: [left_cm, centre_cm, right_cm], None where a sensor had no echo.
    """

    def __init__(self):
        self._last_column: Optional[int] = None

    @property
    def channel_count(self) -> int:
        return GRID_SIZE

    def reset(self) -> None:
        self._last_column = None

    def channels(self, sample) -> list:
        values = list(sample) + [None] * GRID_SIZE
        return [_valid_cm(v) for v in values[:GRID_SIZE]]

    def nearest_raw_cm(self, raw_channels) -> Optional[float]:
        present = [v for v in raw_channels if v is not None]
        return min(present) if present else None

    @staticmethod
    def _pool(filtered, area):
        candidates = [(i, d, area.contains(i, d))
                      for i, d in enumerate(filtered) if d is not None]
        in_bounds = [c for c in candidates if c[2]]
        # A sensor inside its own play area always beats one outside it,
        # however near: a sensor staring past the board is not the player.
        return (in_bounds or candidates), bool(in_bounds)

    def nearest_column(self, filtered, area) -> Optional[int]:
        pool, _ = self._pool(filtered, area)
        return min(pool, key=lambda c: c[1])[0] if pool else None

    def locate(self, filtered, area, config) -> Fix:
        pool, challenger_in_bounds = self._pool(filtered, area)

        if not pool:
            self._last_column = None
            return Fix(STATUS_NO_SIGNAL)

        # min() keeps the first of equal distances, as the JS strict < does.
        column, best = min(((i, d) for i, d, _ in pool), key=lambda c: c[1])

        last = self._last_column
        if last is not None and column != last and filtered[last] is not None:
            incumbent_in_bounds = area.contains(last, filtered[last])
            # An out-of-bounds incumbent must never block an in-bounds challenger.
            incumbent_valid = incumbent_in_bounds or not challenger_in_bounds
            if incumbent_valid and best > filtered[last] - config.column_margin_cm:
                column, best = last, filtered[last]

        if best > area.max_cm:
            return Fix(STATUS_OUT_OF_BOUNDS, column=column, distance_cm=best)

        self._last_column = column
        return Fix(STATUS_OK, x_cm=area.column_centre_cm(column), y_cm=best,
                   column=column, distance_cm=best)


class CartesianGeometry(Geometry):
    """A position that arrives already as (x_cm, y_cm).

    For a rig that works out position itself - such as the servo scanner in
    src/scanning.cpp - so the server only has to filter it. x and y are
    filtered as independent channels; y doubles as the distance from the
    screen for the proximity guard.

    Sample: (x_cm, y_cm), or None when the rig has no position.
    """

    @property
    def channel_count(self) -> int:
        return 2

    def channels(self, sample) -> list:
        if sample is None:
            return [None, None]
        x, y = sample
        # These are positions, not echo distances: a negative x is simply off
        # the left of the board, so only non-finite values mean "no reading".
        # Running them through _valid_cm would misreport that as no signal.
        return [_finite(x), _finite(y)]

    def nearest_raw_cm(self, raw_channels) -> Optional[float]:
        return raw_channels[1]

    def nearest_column(self, filtered, area) -> Optional[int]:
        return area.column_at(filtered[0]) if filtered[0] is not None else None

    def locate(self, filtered, area, config) -> Fix:
        x, y = filtered
        if x is None or y is None:
            return Fix(STATUS_NO_SIGNAL)
        if not 0 <= x <= area.width_cm or y > area.max_cm:
            return Fix(STATUS_OUT_OF_BOUNDS, x_cm=x, y_cm=y)
        column = area.column_at(x)
        return Fix(STATUS_OK, x_cm=x, y_cm=y, column=column, distance_cm=y)


# =============================================================================
# Stage 4 - cell vote
# =============================================================================

class CellStabiliser:
    """Majority vote over recent cells. Port of stabiliseCell().

    The output is a discrete cell, so the robust answer is the mode of recent
    cells rather than the latest one. A one-off jump never wins the vote.
    """

    def __init__(self, config: FilterConfig):
        self._window = config.cell_window
        self._votes = config.cell_votes
        self.reset()

    def reset(self) -> None:
        self._history: deque = deque(maxlen=self._window)
        self.cell: Optional[tuple] = None

    def vote(self, gx: int, gy: int) -> tuple:
        self._history.append((gx, gy))

        # Deliberately the same running-count loop as the JS. On a tie the
        # winner is whichever cell's running count REACHED the maximum first,
        # which is not the same as the cell seen first - [A, B, B, A] picks B.
        counts: dict = {}
        winner, winner_votes = self._history[0], 0
        for cell in self._history:
            counts[cell] = counts.get(cell, 0) + 1
            if counts[cell] > winner_votes:
                winner, winner_votes = cell, counts[cell]

        # The first lock-on adopts immediately so the cursor appears without
        # delay; after that a rival must win a clear majority to take over.
        if self.cell is None or (winner != self.cell and winner_votes >= self._votes):
            self.cell = winner
        return self.cell


# =============================================================================
# Stage 5 - hold and recovery (swappable policy)
# =============================================================================

class HoldPolicy(ABC):
    """Decides whether to keep showing the last good cell through bad readings."""

    @abstractmethod
    def record(self, usable: bool) -> None:
        """Note whether the latest reading produced a usable cell."""

    @abstractmethod
    def keep_holding(self) -> bool:
        """True while bad readings should still be ridden out."""

    @property
    @abstractmethod
    def bad_count(self) -> int:
        """Bad readings currently counted against the policy."""

    @abstractmethod
    def reset(self) -> None: ...


class StreakHold(HoldPolicy):
    """Hold until more than N CONSECUTIVE bad readings. Matches game.js on main.

    Known weakness: any single good reading resets the streak, so an
    intermittent fault that alternates good and bad never trips it and the
    out-of-bounds message never appears. See MajorityWindowHold.
    """

    def __init__(self, config: FilterConfig):
        self._limit = config.hold_readings
        self._streak = 0

    def record(self, usable: bool) -> None:
        self._streak = 0 if usable else self._streak + 1

    def keep_holding(self) -> bool:
        return self._streak <= self._limit

    @property
    def bad_count(self) -> int:
        return self._streak

    def reset(self) -> None:
        self._streak = 0


class MajorityWindowHold(HoldPolicy):
    """Hold until MOST of the last N readings are bad.

    A rolling window rather than a streak, so intermittent faults are caught.
    Requires a full window before it can release, so a burst at the very start
    of a round cannot trip it.
    """

    def __init__(self, config: FilterConfig):
        self._outcomes: deque = deque(maxlen=config.hold_readings)

    def record(self, usable: bool) -> None:
        self._outcomes.append(usable)

    def keep_holding(self) -> bool:
        if len(self._outcomes) < self._outcomes.maxlen:
            return True
        return self.bad_count * 2 <= len(self._outcomes)

    @property
    def bad_count(self) -> int:
        return sum(1 for ok in self._outcomes if not ok)

    def reset(self) -> None:
        self._outcomes.clear()


# =============================================================================
# The pipeline
# =============================================================================

class CoordinatePipeline:
    """Composes the stages above. One instance per tracked player.

        pipeline = CoordinatePipeline(UltrasonicArrayGeometry())
        result = pipeline.update([left_cm, centre_cm, right_cm], now_ms)
        broadcast(result.to_dict())

    Call update() once per incoming sensor reading - not once per render frame.
    """

    def __init__(self, geometry: Geometry, area: Optional[PlayArea] = None,
                 config: Optional[FilterConfig] = None,
                 hold: Optional[HoldPolicy] = None):
        self.geometry = geometry
        self.area = area or PlayArea.default()
        self.config = config or FilterConfig()
        self.hold = hold or StreakHold(self.config)
        self._channels = [ChannelFilter(self.config) for _ in range(geometry.channel_count)]
        self._guard = ProximityGuard(self.config)
        self._stabiliser = CellStabiliser(self.config)
        self._held_cell: Optional[tuple] = None
        self._held_xy: Optional[tuple] = None
        self._last_ok_ms = -math.inf

    def set_area(self, area: PlayArea) -> None:
        """Apply a new calibration. Row hysteresis state is kept."""
        self.area = area

    def reset(self) -> None:
        for channel in self._channels:
            channel.reset()
        self._guard.reset()
        self._stabiliser.reset()
        self.hold.reset()
        self.geometry.reset()
        self._held_cell = None
        self._held_xy = None
        self._last_ok_ms = -math.inf

    @property
    def rejected(self) -> list:
        return [channel.reject_count for channel in self._channels]

    def update(self, sample, now_ms: float) -> FilteredCoordinate:
        raw = self.geometry.channels(sample)
        filtered = [ch.update(v, now_ms) for ch, v in zip(self._channels, raw)]

        # Safety first, on raw values, before anything is smoothed.
        nearest = self.geometry.nearest_raw_cm(raw)
        too_close = self._guard.update(nearest, self.area.alert_threshold_cm)

        if too_close:
            # A safety state is reported instantly, with no grace at all. It
            # returns BEFORE locate(), exactly as the JS does, so column
            # hysteresis does not advance while the player is too close.
            self._held_cell = None
            self._held_xy = None
            self.hold.reset()
            return FilteredCoordinate(
                STATUS_TOO_CLOSE, y_cm=nearest, raw=raw, filtered=filtered,
                column=self.geometry.nearest_column(filtered, self.area),
                calibrated=self.area.is_calibrated)

        fix = self.geometry.locate(filtered, self.area, self.config)
        base = {"raw": raw, "filtered": filtered, "column": fix.column,
                "calibrated": self.area.is_calibrated}

        cell = self._resolve_cell(fix)
        if cell is not None:
            raw_gx, raw_gy = cell
            gx, gy = self._stabiliser.vote(raw_gx, raw_gy)
            self.hold.record(True)
            self._held_cell = (gx, gy)
            self._held_xy = (fix.x_cm, fix.y_cm)
            self._last_ok_ms = now_ms
            return FilteredCoordinate(STATUS_OK, x_cm=fix.x_cm, y_cm=fix.y_cm,
                                      gx=gx, gy=gy, raw_gx=raw_gx, raw_gy=raw_gy,
                                      **base)

        self.hold.record(False)
        within_timeout = now_ms - self._last_ok_ms <= self.config.hold_timeout_ms
        if self._held_cell is not None and self.hold.keep_holding() and within_timeout:
            gx, gy = self._held_cell
            x, y = self._held_xy
            return FilteredCoordinate(STATUS_OK, x_cm=x, y_cm=y, gx=gx, gy=gy,
                                      held=True, held_for=self.hold.bad_count, **base)

        self._held_cell = None
        self._held_xy = None
        status = STATUS_OUT_OF_BOUNDS if fix.status == STATUS_OK else fix.status
        return FilteredCoordinate(status, held_for=self.hold.bad_count, **base)

    def _resolve_cell(self, fix: Fix) -> Optional[tuple]:
        """rawToGrid(): map a located fix to a cell, if it is inside the area."""
        if fix.status != STATUS_OK:
            return None
        if not self.area.contains(fix.column, fix.distance_cm):
            return None
        previous = (self._held_cell[1]
                    if self._held_cell and self._held_cell[0] == fix.column else None)
        return fix.column, self.area.row_for(fix.column, fix.distance_cm, previous)


# =============================================================================
# Helpers
# =============================================================================

def _clamp(value, low, high):
    return max(low, min(high, value))


def _finite(value) -> Optional[float]:
    """A finite number, or None."""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _valid_cm(value) -> Optional[float]:
    """A usable echo distance, or None. Negative means no echo, not zero."""
    number = _finite(value)
    return number if number is not None and number >= 0 else None
