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
from dataclasses import dataclass, field, replace
from functools import lru_cache
from typing import Optional, Sequence

from tracking import (ConstantVelocityTracker, DEFAULT_SIGMA_A_CM_S2,
                      DEFAULT_SIGMA_R_CM)

GRID_SIZE = 3
# How long the grid is from the nodes' edge (Aaron, 5 Oct): the angle limit's
# far edge. GRID_LENGTH_CM in game.js.
GRID_LENGTH_CM = 160.0

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

    # The Kalman switch (tuning.kalman; Aaron, 5 Oct). False turns off both
    # Kalman filters: each channel goes median -> FFT (ChannelFilter), and line
    # of sight starts its track again at every reading, with no gate
    # (LineOfSightTracker). CoordinatePipeline.set_kalman() flips it live.
    kalman: bool = True

    # The angle limit (tuning.angleLimit; Aaron, 5 Oct). A node's filtered
    # distance further than its servo line runs on the grid (angle_limit_cm())
    # plus far_leeway of it is not a player on it: line of sight and Dynamic's
    # node rules drop the reading; trilateration ignores the limit.
    # CoordinatePipeline.set_angle_limit() flips it live.
    angle_limit: bool = True
    # The leeway at great distances (tuning.farLeeway; Aaron, 5 Oct: +20
    # percent), as a share: the angle limit, and the far edge a node's own
    # point may reach (TwoSensorGeometry._own_point()), are this much further.
    far_leeway: float = 0.2

    # The dead zone (tuning.deadZone; Aaron, 5 Oct): the strip across the
    # front of the grid, the alert threshold (10 cm) deep. True: a raw reading
    # is too close when its point along the node's servo line is in it
    # (Geometry.nearest_depth_cm()). False: the raw reading itself is checked,
    # whatever the angle. CoordinatePipeline.set_dead_zone() flips it live.
    dead_zone: bool = True

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

    # Trilateration's beam check (tuning.triBeamHalfDeg): a crossing of the two
    # distance circles counts only within this many degrees of where each
    # node's servo points, widened by body_half_width_cm either side. The
    # sensors' beam is under 15 degrees wide.
    tri_beam_half_deg: float = 7.5
    # The aim tolerance (tuning.triAimTolerance, tuning.triAimToleranceDeg;
    # 5 Oct). True: the beam check lets a crossing be tri_aim_tolerance_deg
    # further off each servo's aim than the beam alone. In the centre test
    # (4 Oct) the left servo reported about 20 degrees further in than the
    # taped spots needed, so the beam check threw away crossings 3 cm from the
    # spot for one node's own point 28 cm off. Only the beam check widens:
    # _in_play_along() keeps the beam itself.
    # CoordinatePipeline.set_tri_aim_tolerance() flips it live.
    tri_aim_tolerance: bool = True
    tri_aim_tolerance_deg: float = 20.0

    # The player is a body, not a point (tuning.bodyRadiusCm,
    # tuning.bodyHalfWidthCm). An echo comes back off the side of the player
    # nearest the node, so each distance falls body_radius_cm short of the
    # middle of them and has it added back (body_centre_cm()). A node's servo
    # stops wherever its beam finds the player, so its aim can be
    # body_half_width_cm either side of their middle; the line of sight and
    # the beam check allow for it.
    body_radius_cm: float = 15.0
    body_half_width_cm: float = 20.0

    # Dynamic, the default position method (tuning.dynamicSteadyMs): a method
    # that has kept the player in one square this long counts as fully steady
    # (DynamicPicker).
    dynamic_steady_ms: float = 1000.0

    # Dynamic's two rules, checked before the steadiest method
    # (TwoSensorGeometry._rule(); tuning.centreSeenMs, tuning.centreHoldMs,
    # tuning.confidentReadings, tuning.confidentMs; Aaron, 5 Oct). The centre
    # rule crosses each node's servo line from its last reading that found or
    # half-found the player, if both are within centre_seen_ms, and keeps the
    # player in the centre column for centre_hold_ms after the lines last
    # crossed in it while both are recent. A node is confident when its last
    # confident_readings readings found the player, the latest within
    # confident_ms, and its own reading is inside the play area; a lone
    # confident node places the player by itself.
    centre_seen_ms: float = 1500.0
    centre_hold_ms: float = 1000.0
    confident_readings: int = 2
    confident_ms: float = 1500.0
    # Far priority (tuning.farPriorityCm, tuning.farSeenMs; Aaron, 6 Oct;
    # TwoSensorGeometry._far_fix()): a node's reading past far_priority_cm (its
    # own distance, before the body radius) counts for far_seen_ms - long
    # enough to cover the other node's turn - however few of its readings are
    # that far.
    far_priority_cm: float = 110.0
    far_seen_ms: float = 1500.0
    # The side-column lock needs the servo lines to cross at least this far
    # inside the left or right column (tuning.sideLockDepthCm). And each of
    # Dynamic's rules on or off, from the control panel (tuning.farPriority,
    # tuning.confidenceNode, tuning.columnLock, tuning.loneNode,
    # tuning.cornerNode; serverFilter.set_dynamic_rules()).
    side_lock_depth_cm: float = 20.0
    far_priority: bool = True
    confidence_node: bool = True
    column_lock: bool = True
    lone_node: bool = True
    corner_node: bool = True
    # Dynamic's first rule (tuning.confidenceNode, tuning.confidenceLevelPct;
    # Aaron, 5 Oct): a node whose confidence from the server (handover.py) is
    # at least this many percent places the player on its own
    # (TwoSensorGeometry._level_node(); serverFilter.set_confidence_level()).
    confidence_level_pct: int = 80

    # Out of bounds, the only one the pipeline reports (Aaron, 5 Oct): both
    # nodes are lost, with no hold. A node is lost when its last lost_readings
    # readings, scored found +1, half 0, lost -1, add up to 0 or less, and not
    # before it has had that many (tuning.lostReadings, set from the control
    # panel; TwoSensorGeometry._nobody_found()). 21 since 5 Oct (Aaron); it
    # was 8. With far_half on (tuning.farHalf), a half reading whose own point
    # is in the back row scores +1, as found (TwoSensorGeometry._in_back_row()).
    lost_readings: int = 21
    far_half: bool = True

    # Geometry (COLUMN_MARGIN_CM)
    column_margin_cm: float = 8.0

    # Safety (TOO_CLOSE_FRAMES)
    too_close_frames: int = 2

    # Cell vote (tuning.cellWindow, tuning.cellVotes), used with the cell
    # decision off
    cell_window: int = 25
    cell_votes: int = 13

    # The cell decision (tuning.cellDecision, cellMarginCm, cellDwellMs,
    # cellStillCm, cellStillHoldMs, cellAnchorRate; CellDecider): on, it decides the cell in
    # place of the vote
    cell_decision: bool = True
    cell_margin_cm: float = 6.0
    cell_dwell_ms: float = 500.0
    cell_still_cm: float = 25.0
    cell_still_hold_ms: float = 1500.0
    cell_anchor_rate: float = 0.1

    # StreakHold and MajorityWindowHold, and tools/chain_replay.py. The
    # pipeline itself rides out unusable readings for as long as they last
    # (CoordinatePipeline.update()), as game.js does since 5 Oct.
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
        if not 1 <= self.lost_readings <= LOST_READINGS_MAX:
            raise ValueError(f"lost_readings must be 1 to {LOST_READINGS_MAX}")


@dataclass(frozen=True)
class PlayArea:
    """Calibrated play-area bounds. Mirrors getBounds() in callibrate_corners.js.

    per_column holds (near_cm, far_cm) for each of the three columns. Use
    PlayArea.default() before calibration and PlayArea.calibrated() after.
    """

    # The rows start behind the dead zone, the front ABSOLUTE_ALERT_CM of the
    # grid, and end at its far edge (GRID_LENGTH_CM): three rows of 50 cm,
    # square with the columns (Aaron, 5 Oct). DEFAULT_NEAR_CM/DEFAULT_FAR_CM
    # in callibrate_corners.js.
    per_column: tuple = ((10.0, 160.0),) * GRID_SIZE
    is_calibrated: bool = False
    width_cm: float = 150.0

    EDGE_MARGIN_CM = 15.0
    ABSOLUTE_ALERT_CM = 10.0
    # The nodes' range (src/Config.h MAX_TARGET_CM, 190) plus the body radius
    # (15): a far edge 160 cm out must still be capturable (MAX_COORD_CM in
    # game.js).
    ABSOLUTE_MAX_CM = 205.0
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

    def contains_point(self, x_cm: float, y_cm: float) -> bool:
        """isPointInPlayArea(): is the point (x across, y out from the screen)
        on the board, give or take EDGE_MARGIN_CM on every side? The column x
        falls in sets the depth span."""
        if x_cm is None or y_cm is None or not (math.isfinite(x_cm) and math.isfinite(y_cm)):
            return False
        if not -self.EDGE_MARGIN_CM <= x_cm <= self.width_cm + self.EDGE_MARGIN_CM:
            return False
        return self.contains(self.column_at(x_cm), y_cm)

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
    nobody_found: bool = False  # out of bounds: neither node finds the player; no hold
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
        self._angle: Optional[float] = None
        self.value: Optional[float] = None
        self._last_good_ms = -math.inf
        self._anchor: Optional[float] = None
        self._anchor_ms = -math.inf
        self.reject_count = 0

    def update(self, raw: Optional[float], now_ms: float,
               angle: Optional[float] = None) -> Optional[float]:
        # Back after a silence - the other node's scanning turn, as a rule.
        # What the channel remembers is where the player was a turn ago, so it
        # starts again from this reading. A range at a new bearing (the servo
        # angle it was read at) is not another sample of the old track either.
        if now_ms - self._stepped_ms > self._cfg.hold_ms or angle != self._angle:
            self._restart_channel()
        self._stepped_ms = now_ms
        self._angle = angle

        # An impossible jump is treated exactly like a dropout: it never enters
        # the median window, so it cannot drag the value toward itself.
        if raw is not None and not self._plausible(raw, now_ms):
            raw = None

        if raw is not None:
            self._samples.append(raw)
            ordered = sorted(self._samples)
            middle = ordered[len(ordered) // 2]
            tracked = (self._tracker.update(middle, now_ms / 1000.0) if self._cfg.kalman
                       else middle)
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

    def nearest_depth_cm(self, raw_channels: Sequence[Optional[float]]) -> Optional[float]:
        """What the proximity guard checks with the dead zone on: the nearest
        raw reading's depth out from the nodes. A geometry with no servo
        angles reads straight out, so its distance is the depth."""
        return self.nearest_raw_cm(raw_channels)

    @abstractmethod
    def locate(self, filtered: Sequence[Optional[float]], area: PlayArea,
               config: FilterConfig) -> Fix:
        """Resolve filtered channels to a position, or a non-ok status."""

    def nearest_column(self, filtered: Sequence[Optional[float]],
                       area: PlayArea) -> Optional[int]:
        """Best-guess column WITHOUT touching any state. Used while too close,
        when the column is reported but hysteresis must not advance."""
        return None

    def channel_angles(self) -> list:
        """The bearing each channel was read at in the last channels() call,
        None for none. A channel starts again when its bearing changes."""
        return [None] * self.channel_count

    def track(self, filtered: Sequence[Optional[float]], fresh: Sequence[bool],
              now_ms: float, area: PlayArea, config: FilterConfig,
              heard: Optional[Sequence[bool]] = None) -> None:
        """Advance any tracker the geometry keeps, once per update and before
        the proximity check. fresh marks the channels carrying a new reading;
        heard, the nodes whose message actually arrived (fresh also marks a
        channel with no reading). Most geometries keep none."""

    def reset(self) -> None:
        """Clear any state carried between updates. Override if stateful."""

    def reading_points(self, raw: Sequence[Optional[float]],
                       filtered: Sequence[Optional[float]], fresh: Sequence[bool],
                       area: PlayArea) -> list:
        """readingNodes() in game.js: (slot, (x_cm, y_cm)) for each node that
        read this update and sees the player, at its own point. A geometry
        with no servo angles has none, and the cell decision then goes by the
        position alone."""
        return []


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


# The most readings a node's lost score can be taken over (FilterConfig
# lost_readings; LOST_READINGS_MAX in game.js).
LOST_READINGS_MAX = 50

POSITION_METHODS = ("dyn", "los", "tri", "avg")
# The methods Dynamic picks between, in the order that breaks a tie
# (DYNAMIC_METHODS in game.js).
DYNAMIC_METHODS = ("los", "tri", "avg")
OFF_BOARD = -1         # DynamicPicker: a position off the board is a square too
# How far inside the board's edges a position is kept, as a share of a square
# (EDGE_INSET in game.js): off the board, the player is placed this far in from
# the edge, inside the edge square's hole.
EDGE_INSET = 0.1

# The sensors' datasheet range (HC-SR04; the RCWL-1601 is a pin-compatible
# copy): a distance outside it is not a reading. SENSOR_*_CM in game.js.
SENSOR_MIN_CM = 2.0
SENSOR_MAX_CM = 400.0
SCAN_FOUND = 0         # scanState: both heads hear the player
# Dynamic's rule switches: the control panel's names (setDynamicRules() in
# game.js) -> FilterConfig fields.
DYNAMIC_RULE_SWITCHES = {"farPriority": "far_priority", "confidenceNode": "confidence_node",
                         "columnLock": "column_lock", "loneNode": "lone_node",
                         "cornerNode": "corner_node"}
SCAN_HALF = 1          # scanState: one head hears the player
SCAN_LOST = 2         # scanState: sweeping, the player is not in its line of sight


def lost_score(state, back_row: bool = False, far_half: bool = False) -> int:
    """lostScore() in game.js: a reading's score towards its node being lost
    (Aaron, 5 Oct): found +1, half 0, lost -1; with far_half on, a half
    reading whose own point was in the back row (back_row) +1, as found."""
    if state == SCAN_FOUND:
        return 1
    if state == SCAN_LOST:
        return -1
    return 1 if far_half and back_row else 0


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
    point along its line of sight (distance_cm is to the middle of the player,
    body_centre_cm()) and that point's 2x2 covariance: small along the line;
    across it, the distance times the bearing uncertainty and
    body_half_width_cm (the aim can stop anywhere across the player) added in
    quadrature.

    repeats is how many readings in a row have already used this same aim: a
    servo that holds still repeats the same aim error, on the same part of the
    player, so the k-th repeat counts 1/(k+1)^2 as much across the line (a
    held aim adds up to about one and a half readings' worth) while the
    distance counts in full."""
    phi = (angle_deg - 90) * math.pi / 180
    along = [math.sin(phi), math.cos(phi)]
    across = [math.cos(phi), -math.sin(phi)]
    if scan_state == 0:
        bearing_deg = config.los_bearing_found_deg
    elif scan_state == 1:
        bearing_deg = config.los_bearing_half_deg
    else:
        bearing_deg = config.los_bearing_unknown_deg
    radial = config.los_range_sigma_cm * config.los_range_sigma_cm
    aim = distance_cm * bearing_deg * math.pi / 180
    body = config.body_half_width_cm
    tangential = (aim * aim + body * body) * (repeats + 1) * (repeats + 1)
    cov = [[radial * along[i] * along[j] + tangential * across[i] * across[j]
            for j in range(2)] for i in range(2)]
    return node_x_cm + distance_cm * math.sin(phi), distance_cm * math.cos(phi), cov


class LineOfSightTracker:
    """The line-of-sight 2D Kalman filter: port of losTrack and the los*()
    functions in game.js, operation for operation.

    State [x, y, vx, vy] in cm and cm/s, constant velocity with white-noise
    acceleration. Each node reading that has the player in its line of sight
    (new, with a distance and an angle, not sweeping) is used once, when it
    arrives. While a node's servo holds still its aim counts for less with
    every reading (line_of_sight(repeats=...)): the aim repeats the same
    error, and taking it in full again and again would drown the other node's
    distance. Readings far from where the track expects the player are left
    out; los_relock_readings of those in a row from one node restart the track there.
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
        self.outliers = [0] * GRID_SIZE   # each slot's readings in a row that failed the gate

    def step(self, filtered, angles, states, fresh, now_ms: float,
             area: PlayArea, config: FilterConfig) -> None:
        """stepLosTrack(): feed this update's readings, then drop a track that
        has taken nothing for too long."""
        for slot in (self.LEFT, self.RIGHT):
            angle, state = angles[slot], states[slot]
            if (not fresh[slot] or filtered[slot] is None or angle is None
                    or state == SCAN_LOST):
                continue
            # A reading past the angle limit is not used at all.
            if not within_angle_limit(area.column_centre_cm(slot), filtered[slot], angle,
                                      area, config):
                continue
            new_aim = (self.x is None or angle != self.aimed_at[slot]
                       or now_ms - self.fed_ms[slot] > config.hold_ms)
            repeats = 0 if new_aim else self.aim_repeats[slot] + 1
            m = line_of_sight(area.column_centre_cm(slot),
                              body_centre_cm(filtered[slot], config), angle, state,
                              config, repeats)
            # With the Kalman off, each reading starts the track again at its
            # own point: no gate, nothing kept from before.
            took = True
            if config.kalman:
                took = self._observe(m, slot, now_ms, config)
            else:
                self._start(m, slot, now_ms, config)
            if took:
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
        self.outliers = [0] * GRID_SIZE
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
        # Counted per node, as losOutlier() does: the other node's readings can
        # pass the gate on the slack across its line while this one's distance
        # keeps saying the track is wrong.
        self.outliers[slot] += 1
        if self.outliers[slot] < config.los_relock_readings:
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
        self.outliers[slot] = 0
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


class DynamicPicker:
    """Dynamic, the "dyn" position method: which of line of sight,
    trilateration and the average has kept the player in one square of the
    board the longest. Port of stepDynamic() and dynamicLeader() in game.js.

    A method whose square keeps changing (bouncing between columns, say)
    never builds up any time, so it is passed over while another holds still.
    Time in a square counts up to dynamic_steady_ms. Past that a method is
    fully steady, and of two fully steady methods the first in
    DYNAMIC_METHODS wins: line of sight, then trilateration, then the
    average. So a method stuck on something that never moves can lead only
    until line of sight has held its own square that long.

    A square is a cell of the board (gx * 3 + gy), or OFF_BOARD. A method
    with no position has no square and is out of the running until it has
    one again.
    """

    def __init__(self):
        self.reset()

    def reset(self) -> None:
        self._square = dict.fromkeys(DYNAMIC_METHODS)
        self._since = dict.fromkeys(DYNAMIC_METHODS)

    @staticmethod
    def square_of(fix: Optional[tuple], area: PlayArea) -> Optional[int]:
        """squareOf() in game.js: the square a position (x_cm, y_cm) is in,
        or None for no position. No hysteresis: a position that flicks back
        and forth across a boundary changes square every time."""
        if fix is None:
            return None
        x, y = fix
        if not 0.0 <= x <= area.width_cm:
            return OFF_BOARD
        column = area.column_at(x)
        if not area.contains(column, y):
            return OFF_BOARD
        return column * GRID_SIZE + area.row_for(column, y)

    def step(self, fixes: dict, now_ms: float, area: PlayArea) -> None:
        """Once per update: each method's square, and since when it has been
        in it."""
        for method in DYNAMIC_METHODS:
            square = self.square_of(fixes[method], area)
            if square is None:
                self._square[method] = None
                self._since[method] = None
            elif square != self._square[method]:
                self._square[method] = square
                self._since[method] = now_ms

    def leader(self, fixes: dict, now_ms: float, config: FilterConfig) -> Optional[str]:
        """The method Dynamic follows now, or None when none has a position.
        A position not yet stepped (just after a reset) has been held for no
        time."""
        leader = None
        best = -math.inf
        for method in DYNAMIC_METHODS:
            if fixes[method] is None:
                continue
            since = self._since[method]
            held = 0.0 if since is None else min(now_ms - since, config.dynamic_steady_ms)
            if held > best:
                best = held
                leader = method
        return leader


class TwoSensorGeometry(Geometry):
    """Two nodes, LEFT and RIGHT, on the screen line at the centres of the
    outer columns. Port of the positioning in game.js (solvePositions() and
    readSensorCoordinate()).

    Each node is a servo scanner (src/scanning.cpp) that reports its distance
    to the player, the servo angle it was read at (90 is straight out into the
    play area, larger turns towards screen-right, as the rig's servos do) and
    its scan state (0 found, 1 half-found, 2 lost and sweeping). Every method
    places the middle of the player: each distance has body_radius_cm added
    first (body_centre_cm()). method picks how that becomes a position, as the
    game's position switch does:

      "dyn" - Dynamic, the default: first its rules (_rule()) - far
              priority, a node at the confidence level, the far corners, the
              column lock, a lone confident node - and otherwise whichever of
              the other three has kept the player in one square the longest
              (DynamicPicker, stepped by track() once per update).
      "los" - line of sight: LineOfSightTracker, fed by track() once per
              update.
      "tri" - trilateration of the two distances: each distance is a circle
              around its node, and where the two circles cross is the player,
              if the crossing lies inside both nodes' beams (in_beam(), within
              tri_beam_half_deg of each servo's aim, plus
              tri_aim_tolerance_deg with tri_aim_tolerance on). When only one
              reading is inside its own column's play area, the circles miss
              each other, or the crossing is outside a beam, the nearer node
              places the player by its distance along its servo angle
              (scanner_point()), straight in front of itself if it sends no
              angle.
      "avg" - the midpoint of the two.

    With no angle from either node (firmware from before the scanner) there is
    no line of sight, and line of sight and the average are trilateration.

    Sample: [left, centre, right]. Each entry is a distance in cm, a
    (distance_cm, angle_deg) pair, a (distance_cm, angle_deg, scan_state)
    triple, or that and the node's confidence from the server (0-1, or None
    when not ready; handover.py); None where there is no reading. The centre is ignored: there is no
    centre node. Three slots are kept so the browser's [left, centre, right]
    assignment carries over.
    """

    LEFT = 0
    RIGHT = 2

    def __init__(self, method: str = "dyn"):
        self.method = method
        self._los = LineOfSightTracker()
        self._dynamic = DynamicPicker()
        self._last_column: Optional[int] = None
        self._angles: list = [None] * GRID_SIZE
        self._states: list = [None] * GRID_SIZE
        self._confidence: list = [None] * GRID_SIZE
        self._found_ms = [-math.inf] * GRID_SIZE
        # Each node's readings this round, one per reading heard, the latest
        # LOST_READINGS_MAX of them: (scan state, whether its own point was in
        # the back row).
        self._state_log: list = [[] for _ in range(GRID_SIZE)]
        self._seen_aim: list = [None] * GRID_SIZE   # (ms, angle) of the last found/half-found reading
        self._found_streak = [0] * GRID_SIZE         # new readings in a row that found the player
        self._centre_held: Optional[tuple] = None    # (ms, x, y): when and where the lines last crossed in the centre
        self._far_seen: list = [None] * GRID_SIZE    # (ms, distance, angle) of the last reading past far_priority_cm
        self._raw: list = [None] * GRID_SIZE         # this update's distances as they arrived (channels())
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
        self._dynamic.reset()
        self._last_column = None
        self._angles = [None] * GRID_SIZE
        self._states = [None] * GRID_SIZE
        self._confidence = [None] * GRID_SIZE
        self._found_ms = [-math.inf] * GRID_SIZE
        self._state_log = [[] for _ in range(GRID_SIZE)]
        self._seen_aim = [None] * GRID_SIZE
        self._found_streak = [0] * GRID_SIZE
        self._centre_held = None
        self._far_seen = [None] * GRID_SIZE
        self._raw = [None] * GRID_SIZE
        self._now_ms = -math.inf

    def channels(self, sample) -> list:
        # Distances are filtered as channels; each node's angle and scan state
        # are kept for track() and locate(), which run on the same update.
        values = list(sample) + [None] * GRID_SIZE
        out = [None] * GRID_SIZE
        self._angles = [None] * GRID_SIZE
        self._states = [None] * GRID_SIZE
        self._confidence = [None] * GRID_SIZE
        for slot in (self.LEFT, self.RIGHT):
            distance, angle, state, confidence = _split_reading(values[slot])
            out[slot] = _valid_cm(distance)
            self._angles[slot] = _finite(angle)
            self._states[slot] = _finite(state)
            self._confidence[slot] = _finite(confidence)
        self._raw = list(out)
        return out

    def nearest_raw_cm(self, raw_channels) -> Optional[float]:
        present = [v for v in raw_channels if v is not None]
        return min(present) if present else None

    def nearest_depth_cm(self, raw_channels) -> Optional[float]:
        """Each raw reading's depth, its point along the node's servo line:
        turned phi off straight out, a reading is in the dead zone under
        threshold / cos(phi). closeDepthCm() in game.js. The depth is the
        same wherever the node stands across the board, so x is 0 here."""
        depths = [scanner_point(0.0, raw_channels[slot], self._angles[slot])[1]
                  for slot in (self.LEFT, self.RIGHT) if raw_channels[slot] is not None]
        return min(depths) if depths else None

    def channel_angles(self) -> list:
        return list(self._angles)

    def track(self, filtered, fresh, now_ms, area, config, heard=None) -> None:
        self._now_ms = now_ms
        self._config = config
        self._los.step(filtered, self._angles, self._states, fresh, now_ms, area, config)
        heard = fresh if heard is None else heard
        for slot in (self.LEFT, self.RIGHT):
            state = self._states[slot]
            if fresh[slot] and state == SCAN_FOUND:
                self._found_ms[slot] = now_ms
            log = self._state_log[slot]
            if heard[slot] and state is not None:
                log.append((state, self._in_back_row(slot, filtered, area, config)))
            if len(log) > LOST_READINGS_MAX:
                log.pop(0)
        # stepDynamicRules() in game.js. A reading past the angle limit counts
        # as none: it neither builds a found streak nor aims a servo line.
        for slot in (self.LEFT, self.RIGHT):
            if not fresh[slot]:
                continue
            state, angle = self._states[slot], self._angles[slot]
            reading = (filtered[slot] is not None
                       and within_angle_limit(area.column_centre_cm(slot), filtered[slot],
                                              angle, area, config))
            self._found_streak[slot] = (self._found_streak[slot] + 1
                                        if reading and state == SCAN_FOUND else 0)
            if reading and angle is not None and state in (SCAN_FOUND, SCAN_HALF):
                self._seen_aim[slot] = (now_ms, angle)
            self._far_step(slot, area, config)
        crossing = self._lines_crossing(area)
        if crossing is not None and self._in_centre_column(crossing[0], area):
            self._centre_held = (now_ms, crossing[0], crossing[1])
        elif crossing is not None and self._deep_side_column(crossing[0], area) is not None:
            self._centre_held = None
        self._dynamic.step(self._picked_from(filtered, area), now_ms, area)

    def _in_back_row(self, slot, filtered, area, config) -> bool:
        """inBackRow() in game.js: whether a node's reading puts the player in
        the back row - its own point, along its servo line, across the board,
        no nearer than its column's back row (two thirds of the way from the
        near edge to the far one), no further than the far edge plus
        far_leeway - with the reading within the angle limit."""
        distance, angle = filtered[slot], self._angles[slot]
        if distance is None or not within_angle_limit(area.column_centre_cm(slot), distance,
                                                      angle, area, config):
            return False
        x, y = scanner_point(area.column_centre_cm(slot), body_centre_cm(distance, config), angle)
        if not 0.0 <= x <= area.width_cm:
            return False
        near, far = area.per_column[area.column_at(x)]
        back_row = near + ((GRID_SIZE - 1) * (far - near)) / GRID_SIZE
        return back_row <= y <= far * (1 + config.far_leeway)

    def _lost(self, slot, config) -> bool:
        """This node's last lost_readings readings' scores (lost_score())
        add up to 0 or less; never before it has had that many."""
        log = self._state_log[slot]
        n = config.lost_readings
        if len(log) < n:
            return False
        total = 0
        for state, back_row in log[-n:]:
            total += lost_score(state, back_row, config.far_half)
        return total <= 0

    def _nobody_found(self, config, area=None) -> bool:
        """bothNodesLost() in game.js: both nodes are lost (_lost()). A node
        that sends no scan state never is. With Dynamic on, far priority's
        position (_far_fix()) is someone on the board, however lost the nodes
        are."""
        left = self._lost(self.LEFT, config)
        right = self._lost(self.RIGHT, config)
        if left and right and self.method == "dyn" and area is not None:
            return self._far_fix(area) is None
        return left and right

    def _far_step(self, slot, area, config) -> None:
        """farStep() in game.js: far priority's memory of this node's new
        reading. A reading past far_priority_cm - the node's own distance, as
        it arrived (channels()) - that found or half-found something, with an
        angle and within the angle limit, is kept; one nearer that found the
        player, the node's confident_readings-th found reading in a row,
        forgets it. No-echo, half and lone nearer readings leave it alone."""
        distance, state, angle = self._raw[slot], self._states[slot], self._angles[slot]
        if distance is None or angle is None:
            return
        if distance > config.far_priority_cm:
            if (state in (SCAN_FOUND, SCAN_HALF)
                    and within_angle_limit(area.column_centre_cm(slot), distance, angle, area, config)):
                self._far_seen[slot] = (self._now_ms, distance, angle)
        elif state == SCAN_FOUND and self._found_streak[slot] >= config.confident_readings:
            self._far_seen[slot] = None

    def _far_fix(self, area) -> Optional[tuple]:
        """farFix() in game.js: far priority's position, (x_cm, y_cm), or
        None - both nodes' far readings (_far_step()) are within far_seen_ms
        and agree: their distances, to the middle of the player, cross inside
        both nodes' beams as each was aimed (in_beam(), with the aim
        tolerance), on the board. None with the rule off."""
        config = self._config or FilterConfig()
        left, right = self._far_seen[self.LEFT], self._far_seen[self.RIGHT]
        if not config.far_priority or left is None or right is None:
            return None
        if self._now_ms - left[0] > config.far_seen_ms or self._now_ms - right[0] > config.far_seen_ms:
            return None
        d_left = body_centre_cm(left[1], config)
        d_right = body_centre_cm(right[1], config)
        x_left = area.column_centre_cm(self.LEFT)
        x_right = area.column_centre_cm(self.RIGHT)
        base = x_right - x_left
        along = (d_left * d_left - d_right * d_right + base * base) / (2 * base)
        h2 = d_left * d_left - along * along
        if h2 < 0:
            return None
        x = x_left + along
        y = math.sqrt(h2)
        half = config.tri_beam_half_deg + (config.tri_aim_tolerance_deg
                                           if config.tri_aim_tolerance else 0)
        body = config.body_half_width_cm
        if not (in_beam(x_left, left[2], x, y, half, body)
                and in_beam(x_right, right[2], x, y, half, body)):
            return None
        return (x, y) if area.contains_point(x, y) else None

    def _picked_from(self, filtered, area) -> dict:
        """The positions Dynamic picks between: {"los", "tri", "avg"} ->
        (x_cm, y_cm) or None (solvePositions() in game.js)."""
        tri = self._trilaterate(filtered, area)
        if self._angles[self.LEFT] is None and self._angles[self.RIGHT] is None:
            return {"los": tri, "tri": tri, "avg": tri}
        los = self._los.fix(self._now_ms, self._config) if self._config else None
        avg = los or tri
        if los and tri:
            avg = ((los[0] + tri[0]) / 2, (los[1] + tri[1]) / 2)
        return {"los": los, "tri": tri, "avg": avg}

    def _leader(self, picked_from: dict) -> Optional[str]:
        return self._dynamic.leader(picked_from, self._now_ms, self._config or FilterConfig())

    def _lines_recent(self) -> bool:
        """bothLinesRecent() in game.js: both nodes found or half-found the
        player within centre_seen_ms."""
        config = self._config or FilterConfig()
        left, right = self._seen_aim[self.LEFT], self._seen_aim[self.RIGHT]
        return (left is not None and right is not None
                and self._now_ms - left[0] <= config.centre_seen_ms
                and self._now_ms - right[0] <= config.centre_seen_ms)

    def _lines_crossing(self, area) -> Optional[tuple]:
        """linesCrossing() in game.js: where the two nodes' servo lines cross,
        (x_cm, y_cm), or None when one is not recent or they do not meet in
        front of the nodes."""
        if not self._lines_recent():
            return None
        tan_left = math.tan((self._seen_aim[self.LEFT][1] - 90) * math.pi / 180)
        tan_right = math.tan((self._seen_aim[self.RIGHT][1] - 90) * math.pi / 180)
        if not tan_left > tan_right:
            return None
        y = ((area.column_centre_cm(self.RIGHT) - area.column_centre_cm(self.LEFT))
             / (tan_left - tan_right))
        return area.column_centre_cm(self.LEFT) + y * tan_left, y

    @staticmethod
    def _in_centre_column(x_cm: float, area) -> bool:
        pitch = area.width_cm / GRID_SIZE
        return pitch <= x_cm <= 2 * pitch

    def _deep_side_column(self, x_cm: float, area) -> Optional[int]:
        """deepSideColumn() in game.js: the side column, LEFT or RIGHT, the
        lines' crossing is at least side_lock_depth_cm inside (and on the
        board), or None."""
        config = self._config or FilterConfig()
        pitch = area.width_cm / GRID_SIZE
        if 0.0 <= x_cm <= pitch - config.side_lock_depth_cm:
            return self.LEFT
        if 2 * pitch + config.side_lock_depth_cm <= x_cm <= area.width_cm:
            return self.RIGHT
        return None

    def _column_lock(self, area, steadiest: Optional[tuple]) -> Optional[tuple]:
        """columnLock() in game.js: ("centre" | "lock-left" | "lock-right",
        (x_cm, y_cm)) when the lines cross in the centre column, or deep in a
        side column, or the centre is still held (centre_hold_ms, both lines
        recent); otherwise None."""
        config = self._config or FilterConfig()
        crossing = self._lines_crossing(area)
        pitch = area.width_cm / GRID_SIZE

        def centre(x, y):
            return "centre", (_clamp(x, pitch + config.column_margin_cm,
                                     2 * pitch - config.column_margin_cm),
                              steadiest[1] if steadiest else y)

        if crossing is not None and self._in_centre_column(crossing[0], area):
            return centre(*crossing)
        side = None if crossing is None else self._deep_side_column(crossing[0], area)
        if side is not None:
            return (("lock-left" if side == self.LEFT else "lock-right"),
                    (crossing[0], steadiest[1] if steadiest else crossing[1]))
        held = self._centre_held
        if (held is not None and self._now_ms - held[0] <= config.centre_hold_ms
                and self._lines_recent()):
            return centre(held[1], held[2])
        return None

    def _own_point(self, slot, filtered, area) -> Optional[tuple]:
        """ownPoint() in game.js: a node's own reading, (x_cm, y_cm) - its
        distance along its servo line - or None when it has no reading or
        angle, the reading is past the angle limit, or that point is outside
        the play area (across the board, and between its column's near edge
        and its far edge plus far_leeway)."""
        config = self._config or FilterConfig()
        if filtered[slot] is None or self._angles[slot] is None:
            return None
        if not within_angle_limit(area.column_centre_cm(slot), filtered[slot],
                                  self._angles[slot], area, config):
            return None
        x, y = scanner_point(area.column_centre_cm(slot),
                             body_centre_cm(filtered[slot], config), self._angles[slot])
        if not 0.0 <= x <= area.width_cm:
            return None
        near, far = area.per_column[area.column_at(x)]
        return (x, y) if near <= y <= far * (1 + config.far_leeway) else None

    def reading_points(self, raw, filtered, fresh, area) -> list:
        """readingNodes() in game.js: each node with a fresh reading that is
        not lost (found or half), at its own point (_own_point()), as
        (slot, (x_cm, y_cm)). Called after track(), so the point is this
        update's."""
        points = []
        for slot in (self.LEFT, self.RIGHT):
            if not fresh[slot] or raw[slot] is None or self._states[slot] == SCAN_LOST:
                continue
            point = self._own_point(slot, filtered, area)
            if point is not None:
                points.append((slot, point))
        return points

    def _confident_point(self, slot, filtered, area) -> Optional[tuple]:
        """confidentPoint() in game.js: a confident node's own reading
        (_own_point()), or None when the node is not confident."""
        config = self._config or FilterConfig()
        if (self._found_streak[slot] < config.confident_readings
                or self._now_ms - self._found_ms[slot] > config.confident_ms):
            return None
        return self._own_point(slot, filtered, area)

    def _level_node(self, filtered, area) -> Optional[tuple]:
        """levelNode() in game.js: (slot, point) for the node whose confidence
        is at the confidence level and whose own reading (_own_point()) is in
        play, or None. Both: the higher confidence; equal: neither."""
        config = self._config or FilterConfig()
        at = []
        for slot in (self.LEFT, self.RIGHT):
            score = self._confidence[slot]
            if score is None or not score * 100 >= config.confidence_level_pct:
                continue
            point = self._own_point(slot, filtered, area)
            if point is not None:
                at.append((slot, score, point))
        if not at or (len(at) == 2 and at[0][1] == at[1][1]):
            return None
        slot, _, point = at[0] if len(at) == 1 or at[0][1] > at[1][1] else at[1]
        return slot, point

    def _in_far_corner(self, slot, point, area) -> bool:
        """inFarCorner() in game.js: whether a node's own reading puts the
        player in its far corner - A1, the far-left square, for the left
        node; A3, the far-right one, for the right."""
        column = 0 if slot == self.LEFT else GRID_SIZE - 1
        return (area.column_at(point[0]) == column
                and area.row_for(column, point[1]) == GRID_SIZE - 1)

    def _rule(self, filtered, area, steadiest: Optional[tuple]) -> Optional[tuple]:
        """dynamicRule() in game.js: the rule placing the player for Dynamic,
        (placed_by, (x_cm, y_cm)), or None to follow the steadiest method,
        whose position is `steadiest`. Checked in order (Aaron, 5 Oct), each
        with its switch in FilterConfig:

        F. far_priority (Aaron, 6 Oct) - both nodes have read past
           far_priority_cm within far_seen_ms (found or half), and the two
           readings agree: the player is where they cross (_far_fix(); "far"),
           whatever the readings in between.
        0. confidence_node - a node whose confidence from the server is at
           least confidence_level_pct places the player by its own reading
           (_level_node(); "conf-left" / "conf-right"), and the other node is
           left out.
        1. corner_node - the near node in its far corner: a confident node
           (_confident_point()) whose own reading puts the player in A1 (the
           left node) or A3 (the right) places them alone ("corner-left" /
           "corner-right").
        2. column_lock (_column_lock()) - the servo lines cross in the centre
           column ("centre"), or at least side_lock_depth_cm inside a side
           column ("lock-left" / "lock-right"); or the centre is held for
           centre_hold_ms after they last crossed in it, while both lines are
           recent. x is the crossing's (kept column_margin_cm inside the
           centre column), y the steadiest method's, or the crossing's when
           no method has a position.
        3. lone_node - a lone confident node: its distance along its servo
           line places the player ("left" / "right"), and the other node is
           left out. When both are confident, the steadiest method places the
           player."""
        config = self._config or FilterConfig()

        def side(slot):
            return "left" if slot == self.LEFT else "right"

        far = self._far_fix(area)
        if far is not None:
            return "far", far
        if config.confidence_node:
            sure = self._level_node(filtered, area)
            if sure is not None:
                return f"conf-{side(sure[0])}", sure[1]
        points = [(slot, self._confident_point(slot, filtered, area))
                  for slot in (self.LEFT, self.RIGHT)]
        points = [(slot, point) for slot, point in points if point is not None]

        if config.corner_node:
            for slot, point in points:
                if self._in_far_corner(slot, point, area):
                    return f"corner-{side(slot)}", point
        if config.column_lock:
            lock = self._column_lock(area, steadiest)
            if lock is not None:
                return lock
        if config.lone_node and len(points) == 1:
            slot, point = points[0]
            return side(slot), point
        return None

    def _dynamic_pick(self, picked_from: dict, filtered, area) -> tuple:
        """What Dynamic follows and where: (placedBy, (x_cm, y_cm) or None)."""
        leader = self._leader(picked_from)
        steadiest = picked_from[leader] if leader else None
        rule = self._rule(filtered, area, steadiest)
        return rule if rule is not None else (leader, steadiest)

    def fixes(self, filtered, area) -> dict:
        """Every method's position: {"dyn", "los", "tri", "avg"} ->
        (x_cm, y_cm) or None. Pure apart from reading the tracker, the
        picker and the rules' state."""
        fixes = self._picked_from(filtered, area)
        fixes["dyn"] = self._dynamic_pick(fixes, filtered, area)[1]
        return fixes

    def placed_by(self, filtered, area) -> Optional[str]:
        """placedBy in game.js: where the position comes from - the method
        switched on, or with Dynamic, the rule's name ("far", "centre",
        "left" / "right" and the rest; _rule()) when one of its rules places
        the player, else the method it follows ("los", "tri" or "avg"; None
        when no method has a position)."""
        if self.method != "dyn":
            return self.method
        return self._dynamic_pick(self._picked_from(filtered, area), filtered, area)[0]

    def position(self, filtered, area) -> Optional[tuple]:
        """(x_cm, y_cm) by the chosen method, or None. x is not yet clamped
        to the board."""
        return self.fixes(filtered, area)[self.method]

    # isInPlayAlong() in game.js checks the beam's arc at this many steps,
    # both ends included.
    BEAM_ARC_STEPS = 15

    def _in_play_along(self, slot, distance, area, config) -> bool:
        """isInPlayAlong() in game.js: whether a node's distance can put the
        player on the board. Not the distance itself, which across the board
        is the long side of the triangle: the echo came from somewhere in the
        sensor's beam, tri_beam_half_deg either side of the servo's aim (a
        15-degree cone), at that distance, and the player is in play if any of
        that arc is on the board. With no angle, the point straight out."""
        node_x = area.column_centre_cm(slot)
        angle = self._angles[slot]
        if angle is None:
            return area.contains_point(*scanner_point(node_x, distance, None))
        half = config.tri_beam_half_deg
        steps = self.BEAM_ARC_STEPS
        return any(area.contains_point(*scanner_point(node_x, distance,
                                                      angle - half + (2 * half * i) / steps))
                   for i in range(steps + 1))

    def _trilaterate(self, filtered, area) -> Optional[tuple]:
        config = self._config or FilterConfig()
        d_left = (body_centre_cm(filtered[self.LEFT], config)
                  if in_sensor_range(filtered[self.LEFT]) else None)
        d_right = (body_centre_cm(filtered[self.RIGHT], config)
                   if in_sensor_range(filtered[self.RIGHT]) else None)
        in_left = d_left is not None and self._in_play_along(self.LEFT, d_left, area, config)
        in_right = d_right is not None and self._in_play_along(self.RIGHT, d_right, area, config)

        if in_left and in_right:
            x_left = area.column_centre_cm(self.LEFT)
            x_right = area.column_centre_cm(self.RIGHT)
            base = x_right - x_left
            along = (d_left * d_left - d_right * d_right + base * base) / (2 * base)
            h2 = d_left * d_left - along * along
            if h2 >= 0:
                x = x_left + along
                y = math.sqrt(h2)
                half = config.tri_beam_half_deg + (config.tri_aim_tolerance_deg
                                                   if config.tri_aim_tolerance else 0)
                body = config.body_half_width_cm
                if (in_beam(x_left, self._angles[self.LEFT], x, y, half, body)
                        and in_beam(x_right, self._angles[self.RIGHT], x, y, half, body)):
                    return x, y

        # One sensor on its own: the nearer in-bounds reading, or failing that
        # the nearer reading of any kind, along its servo angle. Left wins a
        # tie, as in the JS.
        candidates = [(self.LEFT, d_left, in_left), (self.RIGHT, d_right, in_right)]
        candidates = [c for c in candidates if c[1] is not None]
        pool = [c for c in candidates if c[2]] or candidates
        if not pool:
            return None
        column, distance, _ = min(pool, key=lambda c: c[1])
        return scanner_point(area.column_centre_cm(column), distance, self._angles[column])

    def nearest_column(self, filtered, area) -> Optional[int]:
        where = self.position(filtered, area)
        if where is None:
            return None
        return area.column_at(_clamp(where[0], 0.0, area.width_cm))

    def locate(self, filtered, area, config) -> Fix:
        # Neither node has found the player for a while: nobody is on the
        # board, whatever any method still makes of old or stray readings.
        if self._nobody_found(config, area):
            self._last_column = None
            return Fix(STATUS_OUT_OF_BOUNDS, nobody_found=True)
        where = self.position(filtered, area)
        if where is None:
            self._last_column = None
            return Fix(STATUS_NO_SIGNAL)

        inset_x = (area.width_cm / GRID_SIZE) * EDGE_INSET
        x = _clamp(where[0], inset_x, area.width_cm - inset_x)
        column = area.column_at(x)

        # Column hysteresis: next to a column boundary the previous column
        # holds, so noise does not flick the cursor between neighbours.
        last = self._last_column
        if last is not None and abs(column - last) == 1:
            boundary = (area.width_cm / GRID_SIZE) * max(column, last)
            if abs(x - boundary) < config.column_margin_cm:
                column = last

        # Off the board - past a side, past the far edge, in front of the
        # near one - the player is kept on the edge square: x above and y here
        # are brought EDGE_INSET of a square inside the board's edges. The
        # column's calibrated span sets the depth.
        near, far = area.per_column[column]
        inset_y = ((far - near) / GRID_SIZE) * EDGE_INSET
        y = _clamp(where[1], near + inset_y, far - inset_y)

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


class CellDecider:
    """The cell decision. Port of decideCell() in game.js, which says why.

    The cell moves only when the position has gone cell_margin_cm past its
    edges and stayed past them for cell_dwell_ms of readings (twice that to a
    cell not next to it), counted up while readings put the player there and
    down while they put them back. A node whose reading is within
    cell_still_cm of its anchor - its own point from its first reading with
    the position in the cell, eased cell_anchor_rate of the way to each later
    one with the position in the cell - counts for staying, for up to cell_still_hold_ms of the position being
    out of the cell, and not in the first cell_still_hold_ms after the first
    cell is taken: a scan turn changing over moves the position by the
    difference between the nodes' biases, not because anyone moved.
    """

    # CELL_DWELL_STEP_CAP_MS: a longer gap between counted readings counts as this.
    DWELL_STEP_CAP_MS = 250.0

    def __init__(self, config: FilterConfig):
        self.reset()

    def reset(self) -> None:
        self.cell: Optional[tuple] = None
        self._challenger: Optional[tuple] = None
        self._evidence_ms = 0.0
        self._last_ms: Optional[float] = None
        self._first_ms: Optional[float] = None
        self._away: Optional[tuple] = None
        self._away_since: Optional[float] = None
        self._anchors: list = [None] * GRID_SIZE

    @staticmethod
    def _cell_of(x_cm: float, y_cm: float, area: PlayArea) -> tuple:
        """cellOfPosition(): the cell by the grid alone, no hysteresis."""
        gx = area.column_at(x_cm)
        return gx, area.row_for(gx, y_cm)

    @staticmethod
    def _near(cell: tuple, x_cm: float, y_cm: float, area: PlayArea, margin: float) -> bool:
        """nearCell(): (x, y) inside the cell grown by margin cm on every side."""
        near, far = area.per_column[cell[0]]
        row_depth = (far - near) / GRID_SIZE
        top = near + cell[1] * row_depth
        pitch = area.width_cm / GRID_SIZE
        return (cell[0] * pitch - margin <= x_cm <= (cell[0] + 1) * pitch + margin
                and top - margin <= y_cm <= top + row_depth + margin)

    def decide(self, x_cm: float, y_cm: float, counted: bool, points: list,
               now_ms: float, area: PlayArea, config: FilterConfig) -> tuple:
        """The decided cell for an ok fix at (x_cm, y_cm). counted: the update
        carries a node's new reading. points: Geometry.reading_points()."""
        here = self._cell_of(x_cm, y_cm, area)
        if not counted:
            return self.cell if self.cell is not None else here

        if self.cell is None:
            self.cell = here
            self._last_ms = now_ms
            self._first_ms = now_ms
            for slot, point in points:
                self._anchors[slot] = point
            return self.cell

        current = self.cell
        inside = self._near(current, x_cm, y_cm, area, config.cell_margin_cm)
        candidate = current if inside else here
        if inside:
            self._away = None
            self._away_since = None
        elif here != self._away:
            self._away = here
            self._away_since = now_ms
        swing = (not inside and now_ms - self._away_since < config.cell_still_hold_ms
                 and now_ms - self._first_ms >= config.cell_still_hold_ms)

        still = moved = 0
        for slot, point in points:
            anchor = self._anchors[slot]
            if anchor is None:
                if inside:
                    self._anchors[slot] = point
                continue
            if math.hypot(point[0] - anchor[0], point[1] - anchor[1]) < config.cell_still_cm:
                still += 1
            else:
                moved += 1
            if inside:
                rate = config.cell_anchor_rate
                self._anchors[slot] = (anchor[0] + rate * (point[0] - anchor[0]),
                                       anchor[1] + rate * (point[1] - anchor[1]))
        if still > 0 and moved == 0 and swing:
            candidate = current

        step = min(self.DWELL_STEP_CAP_MS, now_ms - self._last_ms)
        self._last_ms = now_ms
        if candidate == current:
            self._evidence_ms = max(0.0, self._evidence_ms - step)
            if self._evidence_ms == 0:
                self._challenger = None
        elif candidate == self._challenger:
            self._evidence_ms += step
        else:
            self._challenger = candidate
            self._evidence_ms = step

        challenger = self._challenger
        if challenger is not None:
            next_to = abs(challenger[0] - current[0]) <= 1 and abs(challenger[1] - current[1]) <= 1
            if self._evidence_ms >= config.cell_dwell_ms * (1 if next_to else 2):
                self.cell = challenger
                self._challenger = None
                self._evidence_ms = 0.0
                self._away = None
                self._away_since = None
                self._anchors = [None] * GRID_SIZE
                for slot, point in points:
                    self._anchors[slot] = point
        return self.cell


# =============================================================================
# Stage 5 - hold and recovery (swappable policy)
# =============================================================================

class HoldPolicy(ABC):
    """Counts bad readings, and decides whether to keep showing the last good
    cell through them. CoordinatePipeline only counts with it: since 5 Oct it
    rides bad readings out for as long as they last, as game.js does, and only
    nobody found (out of bounds) ends a hold. keep_holding() is kept for
    tools/chain_replay.py and experiments."""

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
        self._decider = CellDecider(self.config)
        self._held_cell: Optional[tuple] = None
        self._held_xy: Optional[tuple] = None

    def set_area(self, area: PlayArea) -> None:
        """Apply a new calibration. Row hysteresis state is kept."""
        self.area = area

    def set_kalman(self, on: bool) -> None:
        """The Kalman switch (setKalman() in game.js): both Kalman filters on
        or off from the next reading; nothing else in the config changes."""
        self.config = replace(self.config, kalman=bool(on))
        for channel in self._channels:
            channel._cfg = self.config

    def set_angle_limit(self, on: bool) -> None:
        """The angle limit switch (setAngleLimit() in game.js), from the next
        reading; nothing else in the config changes."""
        self.config = replace(self.config, angle_limit=bool(on))
        for channel in self._channels:
            channel._cfg = self.config

    def set_tri_aim_tolerance(self, on: bool) -> None:
        """The tri aim tolerance switch (setTriAimTolerance() in game.js),
        from the next update; nothing else in the config changes."""
        self.config = replace(self.config, tri_aim_tolerance=bool(on))
        for channel in self._channels:
            channel._cfg = self.config

    def set_dead_zone(self, on: bool) -> None:
        """The dead zone switch (setDeadZone() in game.js), from the next
        update; nothing else in the config changes."""
        self.config = replace(self.config, dead_zone=bool(on))
        for channel in self._channels:
            channel._cfg = self.config

    def set_far_half(self, on: bool) -> None:
        """The far half switch (setFarHalf() in game.js): at once, on the
        readings already kept as well; nothing else in the config changes."""
        self.config = replace(self.config, far_half=bool(on))
        for channel in self._channels:
            channel._cfg = self.config

    def set_cell_decision(self, on: bool) -> None:
        """The cell decision switch (setCellDecision() in game.js): the cell
        decision or the vote from the next reading, either starting afresh;
        nothing else in the config changes."""
        if bool(on) != self.config.cell_decision:
            self._stabiliser.reset()
            self._decider.reset()
        self.config = replace(self.config, cell_decision=bool(on))
        for channel in self._channels:
            channel._cfg = self.config

    def reset(self) -> None:
        for channel in self._channels:
            channel.reset()
        self._guard.reset()
        self._stabiliser.reset()
        self._decider.reset()
        self.hold.reset()
        self.geometry.reset()
        self._held_cell = None
        self._held_xy = None

    def reset_channel(self, channel: int) -> None:
        """Discard one sensor's old bearing without resetting the other nodes."""
        self._channels[channel].reset()

    @property
    def rejected(self) -> list:
        return [channel.reject_count for channel in self._channels]

    def update(self, sample, now_ms: float,
               fresh: Optional[Sequence[bool]] = None,
               heard: Optional[Sequence[bool]] = None) -> FilteredCoordinate:
        """fresh marks which channels carry a NEW reading. A channel marked
        False is not fed again: its filter keeps its current value, so a
        repeated reading never fills the median window. None means all fresh,
        which is what the parity tests and a single-source rig use. The
        proximity guard still sees every channel's raw value. heard marks the
        nodes whose message actually arrived this update, so each scan state
        counts once towards out of bounds (fresh also marks a channel with no
        reading); None means the same as fresh."""
        raw = self.geometry.channels(sample)
        if fresh is None:
            fresh = [True] * len(raw)
        # A range at a new bearing is not another sample of the old track: as
        # in conditionSensor() in game.js, a fresh reading at another scanner
        # angle starts that channel's filter over (ChannelFilter.update).
        angles = self.geometry.channel_angles()
        filtered = [ch.update(v, now_ms, a) if is_fresh else ch.value
                    for ch, v, a, is_fresh in zip(self._channels, raw, angles, fresh)]
        self.geometry.track(filtered, fresh, now_ms, self.area, self.config, heard=heard)

        # Safety first, on raw values, before anything is smoothed. With the
        # dead zone on, each reading counts as its depth along its servo line.
        nearest = (self.geometry.nearest_depth_cm(raw) if self.config.dead_zone
                   else self.geometry.nearest_raw_cm(raw))
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
            if self.config.cell_decision:
                # Only an update carrying a node's new reading counts.
                counted = any(is_fresh and value is not None for is_fresh, value in zip(fresh, raw))
                points = self.geometry.reading_points(raw, filtered, fresh, self.area)
                gx, gy = self._decider.decide(fix.x_cm, fix.y_cm, counted, points, now_ms,
                                              self.area, self.config)
            else:
                gx, gy = self._stabiliser.vote(raw_gx, raw_gy)
            self.hold.record(True)
            self._held_cell = (gx, gy)
            self._held_xy = (fix.x_cm, fix.y_cm)
            return FilteredCoordinate(STATUS_OK, x_cm=fix.x_cm, y_cm=fix.y_cm,
                                      gx=gx, gy=gy, raw_gx=raw_gx, raw_gy=raw_gy,
                                      **base)

        self.hold.record(False)
        # Unusable readings are ridden out on the last good cell for as long
        # as they last. Only nobody found (out of bounds) ends it: that wait
        # was the grace.
        if self._held_cell is not None and not fix.nobody_found:
            gx, gy = self._held_cell
            x, y = self._held_xy
            return FilteredCoordinate(STATUS_OK, x_cm=x, y_cm=y, gx=gx, gy=gy,
                                      held=True, held_for=self.hold.bad_count, **base)

        # No cell to ride out on: out of bounds if nobody is found, otherwise
        # no signal yet (the game waits for a first position, with no message).
        self._held_cell = None
        self._held_xy = None
        status = STATUS_OUT_OF_BOUNDS if fix.nobody_found else STATUS_NO_SIGNAL
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
    """The point distance_cm out from the node at node_x_cm along its servo
    angle: (x_cm, y_cm).

    angle_deg is the servo angle: 90 points straight out into the play area,
    larger turns towards screen-right (larger x), as the rig's servos turn
    (the centre test, 4 Oct) and as src/Config.h sets their limits. None means
    straight out. Same arithmetic as scannerPoint() in game.js, operation for
    operation.
    """
    phi = ((90.0 if angle_deg is None else angle_deg) - 90) * math.pi / 180
    return node_x_cm + distance_cm * math.sin(phi), distance_cm * math.cos(phi)


def angle_limit_cm(node_x_cm: float, angle_deg: Optional[float],
                   width_cm: float = 150.0, length_cm: float = GRID_LENGTH_CM) -> float:
    """angleLimitCm() in game.js: how far the servo line of the node at
    node_x_cm runs before it leaves the grid, width_cm across and length_cm
    long, with the nodes on its near edge (Aaron, 5 Oct). 90 degrees is
    straight down the grid and a larger angle turns towards screen-right, as
    in scanner_point(); None is straight down. Same arithmetic, operation for
    operation."""
    phi = ((90.0 if angle_deg is None else angle_deg) - 90) * math.pi / 180
    across = math.sin(phi)
    down = math.cos(phi)
    limit = math.inf
    if across > 0:
        limit = min(limit, (width_cm - node_x_cm) / across)
    if across < 0:
        limit = min(limit, node_x_cm / -across)
    if down > 0:
        limit = min(limit, length_cm / down)
    return limit


def within_angle_limit(node_x_cm: float, distance_cm: float, angle_deg: Optional[float],
                       area: "PlayArea", config: FilterConfig) -> bool:
    """withinAngleLimit() in game.js: whether a node's filtered distance at
    its servo angle can be a player on the grid - no further than
    angle_limit_cm() plus far_leeway of it. Always, with config.angle_limit
    off."""
    return (not config.angle_limit
            or distance_cm <= angle_limit_cm(node_x_cm, angle_deg, area.width_cm)
            * (1 + config.far_leeway))


def body_centre_cm(distance_cm: float, config: FilterConfig) -> float:
    """bodyCentreCm() in game.js: a node's distance to the middle of the
    player - what it measured, to the side of them nearest it, plus
    body_radius_cm."""
    return distance_cm + config.body_radius_cm


def in_sensor_range(distance_cm: Optional[float]) -> bool:
    """inSensorRange() in game.js: a distance the sensors can measure."""
    return distance_cm is not None and SENSOR_MIN_CM <= distance_cm <= SENSOR_MAX_CM


def in_beam(node_x_cm: float, angle_deg: Optional[float], x_cm: float, y_cm: float,
            half_beam_deg: float, body_half_width_cm: float = 0.0) -> bool:
    """inBeam() in game.js: whether the middle of the player can be at
    (x_cm, y_cm) when the node at node_x_cm, its servo at angle_deg (as in
    scanner_point()), sees them - within half_beam_deg of where it points, or
    no more than body_half_width_cm outside that (the beam may have found the
    edge of the player). Operation for operation as the JS does, so the two
    agree to the last bit. No angle means no beam to check."""
    if angle_deg is None:
        return True
    phi = (angle_deg - 90) * math.pi / 180
    dx = x_cm - node_x_cm
    along = math.sin(phi) * dx + math.cos(phi) * y_cm
    across = math.cos(phi) * dx - math.sin(phi) * y_cm
    half_beam = half_beam_deg * math.pi / 180
    return along >= 0 and abs(across) <= along * math.tan(half_beam) + body_half_width_cm


def _split_reading(entry) -> tuple:
    """A sample entry as (distance, angle, scan_state, confidence): a plain
    distance has none of the others, a (distance, angle) pair no scan state,
    and a triple no confidence (the node's from the server, 0-1, or None when
    it is not ready; Dynamic's first rule)."""
    if isinstance(entry, (list, tuple)):
        if len(entry) == 4:
            return entry[0], entry[1], entry[2], entry[3]
        if len(entry) == 3:
            return entry[0], entry[1], entry[2], None
        if len(entry) == 2:
            return entry[0], entry[1], None, None
    return entry, None, None, None


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
