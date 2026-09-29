"""
filterRules.py - the sensor filtering rules as a standalone pipeline.

Ports the conditioning, safety, geometry, vote and hold rules that currently
live in public/displays/game.js (plus the row mapping from
callibrate_corners.js and the alert threshold from alert.js) into Python, so
the filtered coordinate can be computed once on the server and sent to every
client, instead of being recomputed in each browser tab.

Wired into app.py behind the SERVER_FILTERING flag (off by default) through
serverFilter.py. game.js still filters in the browser and remains the rule
owner until the switch-over; see "Filtering pipeline" in the root README.

Pipeline, in order:

    sample ──► Geometry.channels() ──► raw channels
                                          │
                                          ├─► ProximityGuard   (RAW readings)
                                          │
                                          ▼
                                   ChannelFilter per channel
                                   (slew gate -> median -> Kalman
                                    -> FFT low-pass -> hold)
                                          │
                                          ▼
                                   Geometry.track() (the line-of-sight tracker)
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

Geometry is the swappable part. TwoSensorGeometry is today's rig: two servo
scanner nodes, LEFT and RIGHT, placed by line of sight (a 2D Kalman filter fed
each node's distance along its servo angle), by trilateration of the two
distances, or by the average of the two - the game's position switch. UltrasonicArrayGeometry
is the earlier three-sensor rig, kept so logged V1 sessions still replay
(tools/chain_replay.py). CartesianGeometry accepts an (x, y) position
directly, which is the entry point for the servo scanning rig in
src/scanning.cpp once it reports a position. Everything downstream of
Geometry is shared.

Coordinates follow the project convention: x runs left to right across the
play area, y is depth from the screen, and grid cell (0, 0) is nearest the
screen, on the left, with (2, 2) furthest away on the right. (The game draws
the row nearest the screen at the TOP of its board; that is only drawing -
see boardRow() in game.js.)

Standard library only. Run the tests with:

    python -m unittest discover -s Website/tests
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from collections import deque
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Optional, Sequence

from tracking import (ConstantVelocityTracker, DEFAULT_SIGMA_A_CM_S2,
                      DEFAULT_SIGMA_R_CM)

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

    # Smoothing after the median (tuning.kalmanSigmaA, tuning.kalmanSigmaR,
    # tuning.fftWindow, tuning.fftCutoffHz, FFT_MIN_SAMPLES). The Kalman is
    # tracking.ConstantVelocityTracker with its default gap reset and starting
    # velocity; fft_window 0 turns the FFT stage off. The FFT stage measures
    # its sample rate from the window's own timestamps.
    kalman_sigma_a_cm_s2: float = DEFAULT_SIGMA_A_CM_S2
    kalman_sigma_r_cm: float = DEFAULT_SIGMA_R_CM
    fft_window: int = 32
    fft_min_samples: int = 8
    fft_cutoff_hz: float = 3.0

    # Line-of-sight tracker (LOS_* in game.js; tuning.losAccelCmS2 and the
    # tuning.losBearing*Deg). Distances are good along a node's line of sight;
    # across it the uncertainty is the distance times how far off its aim the
    # node may be, which depends on its scan state.
    los_range_sigma_cm: float = 3.0
    los_v0_sigma_cm_s: float = 100.0
    los_accel_cm_s2: float = 150.0
    los_bearing_found_deg: float = 4.0
    los_bearing_half_deg: float = 15.0
    los_bearing_unknown_deg: float = 7.0
    los_gate_nis: float = 13.8          # chi-square, 2 dof, 99.9 %
    los_relock_readings: int = 6
    los_track_timeout_ms: float = 1500.0
    los_both_window_ms: float = 2500.0

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
        if self.fft_window < 0:
            raise ValueError("fft_window cannot be negative (0 turns the FFT stage off)")
        if self.fft_cutoff_hz < 0:
            raise ValueError("the FFT stage needs a cutoff of 0 or more")


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
        """Build from (near, far) per column. Falls back to defaults if any column
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

@lru_cache(maxsize=None)
def _dft_rows(m: int) -> tuple:
    """cos and sin of 2 pi k j / m for every bin k up to m // 2 and sample
    j, worked out once per window length. The same expressions as the loop in
    fftLowpassLast() in game.js, so the values are identical."""
    rows = []
    for k in range(m // 2 + 1):
        rows.append(tuple((math.cos((2 * math.pi * k * j) / m),
                           math.sin((2 * math.pi * k * j) / m)) for j in range(m)))
    return tuple(rows)


def fft_lowpass_last(values: Sequence[float], sample_rate_hz: float,
                     cutoff_hz: float) -> float:
    """The FFT low-pass of a window of readings, read back at the newest one.

    Port of fftLowpassLast() in game.js. The window's least-squares straight
    line is taken out, what is left is mirrored at the newest end (so the
    transform does not treat the window as a loop and wrap the oldest readings
    onto the newest), every bin above cutoff_hz is dropped, and the newest
    sample is rebuilt from the rest with the line added back. Only the kept
    bins are transformed, which gives the same newest sample as numpy's
    rfft, a zeroed top end and irfft (app.fft_filter_ultrasonic() is that
    numpy version, for a whole window). Readings are taken to be
    1 / sample_rate_hz apart.
    """
    n = len(values)
    if n < 2:
        return values[-1]

    t_mean = (n - 1) / 2
    v_mean = 0.0
    for value in values:
        v_mean += value
    v_mean /= n
    sxx = 0.0
    sxy = 0.0
    for i, value in enumerate(values):
        offset = i - t_mean
        sxx += offset * offset
        sxy += offset * (value - v_mean)
    slope = sxy / sxx

    m = 2 * n
    mirrored = [0.0] * m
    for i, value in enumerate(values):
        residual = value - (v_mean + slope * (i - t_mean))
        mirrored[i] = residual
        mirrored[m - 1 - i] = residual

    rows = _dft_rows(m)
    at = n - 1
    total = 0.0
    for k in range(m // 2 + 1):
        if k * sample_rate_hz / m > cutoff_hz:
            break
        re = 0.0
        im = 0.0
        for sample, (cos_kj, sin_kj) in zip(mirrored, rows[k]):
            re += sample * cos_kj
            im -= sample * sin_kj
        phase = (2 * math.pi * k * at) / m
        term = re * math.cos(phase) - im * math.sin(phase)
        total += term if k == 0 or k == m // 2 else 2 * term
    return v_mean + slope * (at - t_mean) + total / m


class ChannelFilter:
    """Slew gate, then median -> Kalman -> FFT low-pass, then hold - for one
    scalar channel.

    Port of isPlausible() and conditionSensor() in game.js. The Kalman stage
    is tracking.ConstantVelocityTracker (game.js's kalmanUpdate() is a port of
    it) and the FFT stage is fft_lowpass_last(). Works on any channel measured
    in centimetres: a sensor distance today, or an x or y coordinate from a
    scanning rig.
    """

    def __init__(self, config: FilterConfig):
        self._cfg = config
        self.reset()

    def reset(self) -> None:
        cfg = self._cfg
        self._samples: deque = deque(maxlen=cfg.median_window)
        self._rejects: deque = deque(maxlen=cfg.relock_readings)
        # The gate above has already turned misses into None, and a channel
        # may legitimately go negative (an x coordinate), so a negative value
        # is a reading here, as it is in game.js's kalmanUpdate().
        self._tracker = ConstantVelocityTracker(sigma_a_cm_s2=cfg.kalman_sigma_a_cm_s2,
                                                sigma_r_cm=cfg.kalman_sigma_r_cm,
                                                negative_is_missing=False)
        self._smoothed: deque = deque(maxlen=cfg.fft_window)
        self._smoothed_ms: deque = deque(maxlen=cfg.fft_window)
        self._stepped_ms = -math.inf
        self.value: Optional[float] = None
        self._last_good_ms = -math.inf
        self._anchor: Optional[float] = None
        self._anchor_ms = -math.inf
        self.reject_count = 0

    def update(self, raw: Optional[float], now_ms: float) -> Optional[float]:
        # Back after a silence - the other node's scanning turn, as a rule.
        # What the channel remembers is where the player was a turn ago, so it
        # starts again from this reading.
        if now_ms - self._stepped_ms > self._cfg.hold_ms:
            self._restart_channel()
        self._stepped_ms = now_ms

        # An impossible jump is treated exactly like a dropout: it never enters
        # the median window, so it cannot drag the value toward itself.
        if raw is not None and not self._plausible(raw, now_ms):
            raw = None

        if raw is not None:
            self._samples.append(raw)
            ordered = sorted(self._samples)
            middle = ordered[len(ordered) // 2]
            tracked = self._tracker.update(middle, now_ms / 1000.0)
            self.value = self._smooth(tracked, now_ms)
            self._last_good_ms = now_ms
            # The gate judges readings against the median, as it always has:
            # the stages after it lag a little, and must not tighten the gate.
            self._anchor = middle
            self._anchor_ms = now_ms
            return self.value

        if now_ms - self._last_good_ms <= self._cfg.hold_ms:
            return self.value                  # coast through the dropout

        self._restart_smoothing()
        self.value = None
        return None

    def _smooth(self, tracked: float, now_ms: float) -> float:
        """One Kalman output, taken at now_ms, into the FFT window; the
        channel's value. The window's sample rate is what its timestamps say
        (smoothWindow() in game.js)."""
        cfg = self._cfg
        if cfg.fft_window <= 0:
            return tracked
        self._smoothed.append(tracked)
        self._smoothed_ms.append(now_ms)
        n = len(self._smoothed)
        if n < min(cfg.fft_min_samples, cfg.fft_window):
            return tracked
        span = (self._smoothed_ms[-1] - self._smoothed_ms[0]) / 1000
        if not span > 0:
            return tracked
        return fft_lowpass_last(list(self._smoothed), (n - 1) / span, cfg.fft_cutoff_hz)

    def _restart_channel(self) -> None:
        """restartChannel() in game.js: nothing the channel remembers - the
        windows, the Kalman, the gate's anchor - still describes the player."""
        self._restart_smoothing()
        self.value = None
        self._last_good_ms = -math.inf
        self._anchor = None
        self._anchor_ms = -math.inf
        self._rejects.clear()

    def _restart_smoothing(self) -> None:
        """The median onwards starts again from the next reading: after a
        re-lock, or once the hold has run out, the old track says nothing
        about the new one."""
        self._samples.clear()
        self._tracker.reset()
        self._smoothed.clear()
        self._smoothed_ms.clear()

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
            self._restart_smoothing()
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

    def track(self, filtered: Sequence[Optional[float]], fresh: Sequence[bool],
              now_ms: float, area: PlayArea, config: FilterConfig) -> None:
        """Advance any tracker the geometry keeps, once per update and before
        the proximity check. fresh marks the channels carrying a new reading.
        Most geometries keep none."""

    def reset(self) -> None:
        """Clear any state carried between updates. Override if stateful."""


class UltrasonicArrayGeometry(Geometry):
    """Three forward-facing sensors on one line, one column each (the V1 rig).

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


POSITION_METHODS = ("los", "tri", "avg")
SCAN_LOST = 2          # scanState: sweeping, the player is not in its line of sight


def _mat_mul(a, b):
    """matMul() in game.js: rows times columns, summed in the same order."""
    out = []
    for i in range(len(a)):
        row = []
        for j in range(len(b[0])):
            total = 0.0
            for k in range(len(b)):
                total += a[i][k] * b[k][j]
            row.append(total)
        out.append(row)
    return out


def _mat_transpose(a):
    return [[row[j] for row in a] for j in range(len(a[0]))]


def _mat_add(a, b):
    return [[value + b[i][j] for j, value in enumerate(row)] for i, row in enumerate(a)]


def line_of_sight(node_x_cm: float, distance_cm: float, angle_deg: float,
                  scan_state: Optional[float], config: FilterConfig,
                  repeats: int = 0) -> tuple:
    """lineOfSight() in game.js: one node's reading as (x_cm, y_cm, cov) - the
    point along its line of sight and that point's 2x2 covariance, small along
    the line and the distance times the bearing uncertainty across it.

    repeats is how many readings in a row have already used this same aim: a
    servo that holds still repeats the same small aim error, so the k-th
    repeat counts 1/(k+1)^2 as much across the line (a held aim adds up to
    about one and a half readings' worth) while the distance counts in full."""
    phi = (angle_deg - 90) * math.pi / 180
    along = [-math.sin(phi), math.cos(phi)]
    across = [math.cos(phi), math.sin(phi)]
    if scan_state == 0:
        bearing_deg = config.los_bearing_found_deg
    elif scan_state == 1:
        bearing_deg = config.los_bearing_half_deg
    else:
        bearing_deg = config.los_bearing_unknown_deg
    radial = config.los_range_sigma_cm * config.los_range_sigma_cm
    sideways = distance_cm * bearing_deg * math.pi / 180 * (repeats + 1)
    tangential = sideways * sideways
    cov = [[radial * along[i] * along[j] + tangential * across[i] * across[j]
            for j in range(2)] for i in range(2)]
    return node_x_cm - distance_cm * math.sin(phi), distance_cm * math.cos(phi), cov


class LineOfSightTracker:
    """The line-of-sight 2D Kalman filter: port of losTrack and the los*()
    functions in game.js, operation for operation.

    State [x, y, vx, vy] in cm and cm/s, constant velocity with white-noise
    acceleration. Each node reading that has the player in its line of sight
    (new, with a distance and an angle, not sweeping) is used once, when it
    arrives. While a node's servo holds still its aim counts for less with
    every reading (line_of_sight(repeats=...)): the aim repeats the same small
    error, and taking it in full again and again would drown the other node's
    distance. Readings far from where the track expects the player are left
    out; los_relock_readings of those in a row restart the track there.
    """

    LEFT = 0
    RIGHT = 2

    def __init__(self):
        self.reset()

    def reset(self) -> None:
        self.x: Optional[list] = None
        self.P: Optional[list] = None
        self.t = 0.0
        self.updated_ms = -math.inf
        self.fed_ms = [-math.inf] * GRID_SIZE
        self.aimed_at = [None] * GRID_SIZE
        self.aim_repeats = [0] * GRID_SIZE
        self.last_slot: Optional[int] = None
        self.outliers = 0

    def step(self, filtered, angles, states, fresh, now_ms: float,
             area: PlayArea, config: FilterConfig) -> None:
        """stepLosTrack(): feed this update's readings, then drop a track that
        has taken nothing for too long."""
        for slot in (self.LEFT, self.RIGHT):
            angle, state = angles[slot], states[slot]
            if (not fresh[slot] or filtered[slot] is None or angle is None
                    or state == SCAN_LOST):
                continue
            new_aim = (self.x is None or angle != self.aimed_at[slot]
                       or now_ms - self.fed_ms[slot] > config.hold_ms)
            repeats = 0 if new_aim else self.aim_repeats[slot] + 1
            m = line_of_sight(area.column_centre_cm(slot), filtered[slot], angle, state,
                              config, repeats)
            if self._observe(m, slot, now_ms, config):
                self.aimed_at[slot] = angle
                self.aim_repeats[slot] = repeats
        if self.x is not None and now_ms - self.updated_ms > config.los_track_timeout_ms:
            self.reset()

    def fix(self, now_ms: float, config: FilterConfig) -> Optional[tuple]:
        """losFix(): (x_cm, y_cm), or None when the track has taken nothing
        for too long."""
        if self.x is None or now_ms - self.updated_ms > config.los_track_timeout_ms:
            return None
        return self.x[0], self.x[1]

    # -- internals -------------------------------------------------------------

    def _took(self, slot: int, now_ms: float) -> None:
        self.updated_ms = now_ms
        self.fed_ms[slot] = now_ms
        self.last_slot = slot

    def _start(self, m, slot, now_ms, config) -> None:
        v0 = config.los_v0_sigma_cm_s * config.los_v0_sigma_cm_s
        mx, my, cov = m
        self.x = [mx, my, 0, 0]
        self.P = [[cov[0][0], cov[0][1], 0, 0],
                  [cov[1][0], cov[1][1], 0, 0],
                  [0, 0, v0, 0],
                  [0, 0, 0, v0]]
        self.t = now_ms / 1000
        self.outliers = 0
        self._took(slot, now_ms)

    def _predict(self, t: float, config: FilterConfig) -> None:
        dt = t - self.t
        if dt <= 0:
            return
        q = config.los_accel_cm_s2 * config.los_accel_cm_s2
        dt2 = dt * dt
        a = q * dt2 * dt2 / 4
        b = q * dt2 * dt / 2
        c = q * dt2
        F = [[1, 0, dt, 0], [0, 1, 0, dt], [0, 0, 1, 0], [0, 0, 0, 1]]
        Q = [[a, 0, b, 0], [0, a, 0, b], [b, 0, c, 0], [0, b, 0, c]]
        x = self.x
        self.x = [x[0] + x[2] * dt, x[1] + x[3] * dt, x[2], x[3]]
        self.P = _mat_add(_mat_mul(_mat_mul(F, self.P), _mat_transpose(F)), Q)
        self.t = t

    def _outlier(self, m, slot, now_ms, config) -> bool:
        self.outliers += 1
        if self.outliers < config.los_relock_readings:
            return False
        self._start(m, slot, now_ms, config)
        return True

    def _apply(self, K, nu, H, R, slot, now_ms) -> None:
        P = self.P
        new_x = []
        for i, value in enumerate(self.x):
            total = 0
            for j, gain in enumerate(K[i]):
                total = total + gain * nu[j]
            new_x.append(value + total)
        self.x = new_x
        KH = _mat_mul(K, H)
        A = [[(1 if i == j else 0) - value for j, value in enumerate(row)]
             for i, row in enumerate(KH)]
        self.P = _mat_add(_mat_mul(_mat_mul(A, P), _mat_transpose(A)),
                          _mat_mul(_mat_mul(K, R), _mat_transpose(K)))
        self.outliers = 0
        self._took(slot, now_ms)

    def _observe(self, m, slot, now_ms, config) -> bool:
        if self.x is None:
            self._start(m, slot, now_ms, config)
            return True
        self._predict(now_ms / 1000, config)
        P = self.P
        mx, my, cov = m
        nu = [mx - self.x[0], my - self.x[1]]
        s00 = P[0][0] + cov[0][0]
        s01 = P[0][1] + cov[0][1]
        s10 = P[1][0] + cov[1][0]
        s11 = P[1][1] + cov[1][1]
        det = s00 * s11 - s01 * s10
        if not det > 0:
            return False
        Si = [[s11 / det, -s01 / det], [-s10 / det, s00 / det]]
        nis = (nu[0] * (Si[0][0] * nu[0] + Si[0][1] * nu[1])
               + nu[1] * (Si[1][0] * nu[0] + Si[1][1] * nu[1]))
        if nis > config.los_gate_nis:
            return self._outlier(m, slot, now_ms, config)
        K = _mat_mul([[row[0], row[1]] for row in P], Si)
        self._apply(K, nu, [[1, 0, 0, 0], [0, 1, 0, 0]], cov, slot, now_ms)
        return True


class TwoSensorGeometry(Geometry):
    """Two nodes, LEFT and RIGHT, on the screen line at the centres of the
    outer columns. Port of the positioning in game.js (solvePositions() and
    readSensorCoordinate()).

    Each node is a servo scanner (src/scanning.cpp) that reports its distance
    to the player, the servo angle it was read at (90 is straight out into the
    play area, larger turns towards screen-left) and its scan state (0 found,
    1 half-found, 2 lost and sweeping). method picks how that becomes a
    position, as the game's position switch does:

      "los" - line of sight: LineOfSightTracker, fed by track() once per
              update. The default.
      "tri" - trilateration of the two distances alone: each distance is a
              circle around its node, and where the two circles cross is the
              player. When only one reading is inside its own column's play
              area, or the circles miss each other, the nearer node places
              the player straight in front of itself.
      "avg" - the midpoint of the two.

    With no angle from either node (firmware from before the scanner) there is
    no line of sight, and every method is trilateration.

    Sample: [left, centre, right]. Each entry is a distance in cm, a
    (distance_cm, angle_deg) pair, or a (distance_cm, angle_deg, scan_state)
    triple; None where there is no reading. The centre is ignored: there is no
    centre node. Three slots are kept so the browser's [left, centre, right]
    assignment carries over.
    """

    LEFT = 0
    RIGHT = 2

    def __init__(self, method: str = "los"):
        self.method = method
        self._los = LineOfSightTracker()
        self._last_column: Optional[int] = None
        self._angles: list = [None] * GRID_SIZE
        self._states: list = [None] * GRID_SIZE
        self._now_ms = -math.inf
        self._config: Optional[FilterConfig] = None

    @property
    def method(self) -> str:
        return self._method

    @method.setter
    def method(self, value: str) -> None:
        if value not in POSITION_METHODS:
            raise ValueError(f"method must be one of {POSITION_METHODS}, not {value!r}")
        self._method = value

    @property
    def channel_count(self) -> int:
        return GRID_SIZE

    def reset(self) -> None:
        self._los.reset()
        self._last_column = None
        self._angles = [None] * GRID_SIZE
        self._states = [None] * GRID_SIZE
        self._now_ms = -math.inf

    def channels(self, sample) -> list:
        # Distances are filtered as channels; each node's angle and scan state
        # are kept for track() and locate(), which run on the same update.
        values = list(sample) + [None] * GRID_SIZE
        out = [None] * GRID_SIZE
        self._angles = [None] * GRID_SIZE
        self._states = [None] * GRID_SIZE
        for slot in (self.LEFT, self.RIGHT):
            distance, angle, state = _split_reading(values[slot])
            out[slot] = _valid_cm(distance)
            self._angles[slot] = _finite(angle)
            self._states[slot] = _finite(state)
        return out

    def nearest_raw_cm(self, raw_channels) -> Optional[float]:
        present = [v for v in raw_channels if v is not None]
        return min(present) if present else None

    def track(self, filtered, fresh, now_ms, area, config) -> None:
        self._now_ms = now_ms
        self._config = config
        self._los.step(filtered, self._angles, self._states, fresh, now_ms, area, config)

    def fixes(self, filtered, area) -> dict:
        """Every method's position: {"los", "tri", "avg"} -> (x_cm, y_cm) or
        None. Pure apart from reading the tracker."""
        tri = self._trilaterate(filtered, area)
        if self._angles[self.LEFT] is None and self._angles[self.RIGHT] is None:
            return {"los": tri, "tri": tri, "avg": tri}
        los = self._los.fix(self._now_ms, self._config) if self._config else None
        avg = los or tri
        if los and tri:
            avg = ((los[0] + tri[0]) / 2, (los[1] + tri[1]) / 2)
        return {"los": los, "tri": tri, "avg": avg}

    def position(self, filtered, area) -> Optional[tuple]:
        """(x_cm, y_cm) by the chosen method, or None. x is not yet clamped
        to the board."""
        return self.fixes(filtered, area)[self.method]

    def _trilaterate(self, filtered, area) -> Optional[tuple]:
        d_left, d_right = filtered[self.LEFT], filtered[self.RIGHT]
        in_left = d_left is not None and area.contains(self.LEFT, d_left)
        in_right = d_right is not None and area.contains(self.RIGHT, d_right)

        if in_left and in_right:
            x_left = area.column_centre_cm(self.LEFT)
            base = area.column_centre_cm(self.RIGHT) - x_left
            along = (d_left * d_left - d_right * d_right + base * base) / (2 * base)
            h2 = d_left * d_left - along * along
            if h2 >= 0:
                return x_left + along, math.sqrt(h2)

        # One sensor on its own: the nearer in-bounds reading, or failing that
        # the nearer reading of any kind. Left wins a tie, as in the JS.
        candidates = [(self.LEFT, d_left, in_left), (self.RIGHT, d_right, in_right)]
        candidates = [c for c in candidates if c[1] is not None]
        pool = [c for c in candidates if c[2]] or candidates
        if not pool:
            return None
        column, distance, _ = min(pool, key=lambda c: c[1])
        return area.column_centre_cm(column), distance

    def nearest_column(self, filtered, area) -> Optional[int]:
        where = self.position(filtered, area)
        if where is None:
            return None
        return area.column_at(_clamp(where[0], 0.0, area.width_cm))

    def locate(self, filtered, area, config) -> Fix:
        where = self.position(filtered, area)
        if where is None:
            self._last_column = None
            return Fix(STATUS_NO_SIGNAL)

        x = _clamp(where[0], 0.0, area.width_cm)
        y = where[1]
        column = area.column_at(x)

        # Column hysteresis: next to a column boundary the previous column
        # holds, so noise does not flick the cursor between neighbours.
        last = self._last_column
        if last is not None and abs(column - last) == 1:
            boundary = (area.width_cm / GRID_SIZE) * max(column, last)
            if abs(x - boundary) < config.column_margin_cm:
                column = last

        if y > area.max_cm:
            return Fix(STATUS_OUT_OF_BOUNDS, x_cm=x, y_cm=y, column=column, distance_cm=y)

        self._last_column = column
        return Fix(STATUS_OK, x_cm=x, y_cm=y, column=column, distance_cm=y)


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

    def update(self, sample, now_ms: float,
               fresh: Optional[Sequence[bool]] = None) -> FilteredCoordinate:
        """fresh marks which channels carry a NEW reading. A channel marked
        False is not fed again: its filter keeps its current value, so a
        repeated reading never fills the median window. None means all fresh,
        which is what the parity tests and a single-source rig use. The
        proximity guard still sees every channel's raw value."""
        raw = self.geometry.channels(sample)
        if fresh is None:
            fresh = [True] * len(raw)
        filtered = [ch.update(v, now_ms) if is_fresh else ch.value
                    for ch, v, is_fresh in zip(self._channels, raw, fresh)]
        self.geometry.track(filtered, fresh, now_ms, self.area, self.config)

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


def scanner_point(node_x_cm: float, distance_cm: float,
                  angle_deg: Optional[float]) -> tuple:
    """Where a scanner node's reading puts the player: (x_cm, y_cm).

    angle_deg is the servo angle: 90 points straight out into the play area,
    larger turns towards screen-left (smaller x). None means straight out.
    Same arithmetic as scannerPoint() in game.js, operation for operation.
    """
    phi = ((90.0 if angle_deg is None else angle_deg) - 90) * math.pi / 180
    return node_x_cm - distance_cm * math.sin(phi), distance_cm * math.cos(phi)


def _split_reading(entry) -> tuple:
    """A sample entry as (distance, angle, scan_state): a plain distance has
    neither, a (distance, angle) pair no scan state."""
    if isinstance(entry, (list, tuple)):
        if len(entry) == 3:
            return entry[0], entry[1], entry[2]
        if len(entry) == 2:
            return entry[0], entry[1], None
    return entry, None, None


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
