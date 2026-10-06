"""
tracking.py - per-sensor constant-velocity Kalman tracker.

Used in two places:

  * Filtering: the middle stage of every channel in filterRules.ChannelFilter
    (slew gate -> median -> THIS -> FFT low-pass -> hold), and of the per-node
    distance in app.py. It runs on the median's output, so it smooths and
    follows the median rather than replacing it: the slew gate and the median
    still stop spikes before they reach it. game.js's kalmanUpdate() is a
    port of update() for the browser's copy of the chain.
  * Path prediction (issue #18): serverFilter.py keeps one tracker per channel
    behind the SERVER_FILTERING flag and publishes the predicted distance
    alongside the coordinate. Predictions (predict(), predict_at()) are still
    not read by the coordinate, the cell vote or the alert.

Neither use feeds the proximity alert, which reads RAW readings.

One tracker per sensor channel. State is [distance_cm, velocity_cm_s],
updated only when that channel reports. Discrete white-noise acceleration
model (Bar-Shalom et al. 2001, sec. 6.3.2):

    x_k = F x_{k-1} + w_k,   F = [[1, dt], [0, 1]]
    Q   = sigma_a^2 [[dt^4/4, dt^3/2], [dt^3/2, dt^2]]
    z_k = H x_k + n_k,       H = [1, 0],  R = sigma_r^2

A median of N readings lags a ramp by (N - 1) / 2 samples; the velocity
state lets this filter track a ramp with zero steady-state lag and predict
ahead through missing readings.

Hardening, so a bad reading cannot run away with the output: a non-finite
reading is missing; nothing extrapolates more than max_lead_s past the last
accepted reading; a distance channel's output stays in [0, max range]. For
raw readings (PathPredictor) a spike gate on the normalised innovation
squared, with re-acquisition after a few agreeing gated readings, and a
velocity limit are on too - the rules of the unit's sensing model (its
track confirmation and coasting decay are not ported).

The filter is causal: update() uses only the current and earlier readings.
It must never feed the proximity alert, which reads RAW readings.

The 2x2 algebra is written out by hand so one update is a few dozen flops.
Standard library only.
"""

from __future__ import annotations

import math
from typing import Optional

# Process noise: white-acceleration level of the player's motion, cm/s^2.
# Tuned in simulation for a responsive filter (steady-state alpha ~0.89 at
# ~79 ms per reading); raise it to follow lunges faster, lower it to smooth.
DEFAULT_SIGMA_A_CM_S2 = 400.0

# Measurement noise: SD of one ultrasonic reading of a person, cm. Estimated
# from logged play at about 100 cm (body sway dominates transducer jitter).
DEFAULT_SIGMA_R_CM = 0.91

# Gap reset: after this long without a reading the track is dropped and the
# next reading starts a new one, s. Longer than a few missed 60 ms cycles,
# shorter than the time for a player to move a whole cell.
DEFAULT_GAP_RESET_S = 0.5

# Initial velocity uncertainty of a new track, cm/s (walking pace ~ 1 m/s).
DEFAULT_V0_SIGMA_CM_S = 100.0

# Lead cap: predict() never extrapolates further ahead than this, s. The
# constant-velocity guess is only good for a few readings (~79 ms apart); at
# 1 m/s a 250 ms cap bounds the extrapolation to 25 cm, about half a row.
# The value used by the unit's sensing model.
DEFAULT_MAX_LEAD_S = 0.25

# Spike gate: a reading whose normalised innovation squared nu^2 / S is above
# this is not used. chi2.ppf(0.99, 1), the gate of the unit's sensing model:
# 1 in 100 good readings is gated.
DEFAULT_NIS_GATE = 6.634896601021214

# Re-acquisition: this many gated readings in a row that agree to within
# REACQ_SPREAD_CM restart the track on the latest (the player really moved).
# Both values are the sensing model's.
REACQ_READINGS = 3
REACQ_SPREAD_CM = 20.0

# Velocity limit, cm/s: faster than a player moves. The sensing model's v_max,
# and the same speed as the slew gate (filterRules.FilterConfig.max_speed_cm_per_s).
DEFAULT_V_MAX_CM_S = 300.0

# Range clamp for a distance channel, cm: returned distances stay in
# [0, DEFAULT_MAX_RANGE_CM]. The HC-SR04's rated range is 2 cm - 4 m; the
# firmware's 9000 us echo timeout already ends near 155 cm. For the team to confirm.
DEFAULT_MAX_RANGE_CM = 400.0


class ConstantVelocityTracker:
    """Constant-velocity Kalman filter for one distance channel, in cm.

    update(z_cm, t_s) feeds one reading (None, NaN, +/-inf or negative = no
    echo, which is missing, never 0 cm) taken at t_s seconds; dt comes from
    the timestamps. predict(ahead_s) returns the extrapolated distance
    without changing the state, or None when there is no track. Every
    returned value is finite, and extrapolates at most max_lead_s past the
    last accepted reading, however many missing readings came since.

    Off unless asked for, because the filtering chain's copy (a port of
    game.js's kalmanUpdate(), fed by the median) has no such rules:
    nis_gate drops a reading whose NIS is above it (PathPredictor turns it
    on), and v_max_cm_s limits the velocity. range_cm clamps what is
    returned; by default [0, DEFAULT_MAX_RANGE_CM] on a distance channel
    and nothing on a signed one (negative_is_missing off)."""

    def __init__(self,
                 sigma_a_cm_s2: float = DEFAULT_SIGMA_A_CM_S2,  # process noise (acceleration), cm/s^2
                 sigma_r_cm: float = DEFAULT_SIGMA_R_CM,        # measurement noise SD, cm
                 gap_reset_s: float = DEFAULT_GAP_RESET_S,      # drop the track after this long without a reading, s
                 v0_sigma_cm_s: float = DEFAULT_V0_SIGMA_CM_S,  # initial velocity SD of a new track, cm/s
                 max_lead_s: float = DEFAULT_MAX_LEAD_S,        # longest extrapolation past the last reading, s
                 negative_is_missing: bool = True,              # a negative reading is a missed echo
                 nis_gate: Optional[float] = None,              # spike gate on nu^2 / S; None = off
                 v_max_cm_s: Optional[float] = None,            # velocity limit, cm/s; None = off
                 range_cm: Optional[tuple] = None):             # (low_cm, high_cm) clamp on returned values
        if sigma_a_cm_s2 <= 0 or sigma_r_cm <= 0:
            raise ValueError("noise levels must be positive")
        if gap_reset_s <= 0:
            raise ValueError("gap_reset_s must be positive")
        if max_lead_s < 0:
            raise ValueError("max_lead_s must not be negative")
        if nis_gate is not None and not nis_gate > 0:
            raise ValueError("nis_gate must be positive")
        if v_max_cm_s is not None and not v_max_cm_s > 0:
            raise ValueError("v_max_cm_s must be positive")
        if range_cm is None and negative_is_missing:
            range_cm = (0.0, DEFAULT_MAX_RANGE_CM)
        if range_cm is not None and not range_cm[0] <= range_cm[1]:
            raise ValueError("range_cm must be (low_cm, high_cm) with low_cm <= high_cm")
        self.sigma_a_cm_s2 = sigma_a_cm_s2
        self.sigma_r_cm = sigma_r_cm
        self.gap_reset_s = gap_reset_s
        self.v0_sigma_cm_s = v0_sigma_cm_s
        self.max_lead_s = max_lead_s
        # A distance is never negative, so by default a negative reading is a
        # missed echo. A channel that can go negative (an x coordinate across
        # the play area) turns this off and is told about misses with None.
        self.negative_is_missing = negative_is_missing
        self.nis_gate = nis_gate
        self.v_max_cm_s = v_max_cm_s
        self.range_cm = range_cm
        self.reset()

    # ------------------------------------------------------------------
    def reset(self) -> None:
        """Drop the track."""
        self.distance_cm: Optional[float] = None   # estimate at time t_s
        self.velocity_cm_s = 0.0
        self.p00 = self.p01 = self.p11 = 0.0        # covariance [[p00, p01], [p01, p11]]
        self.t_s: Optional[float] = None            # time of the state (the last accepted reading)
        self.t_reading_s: Optional[float] = None    # time of the last accepted reading
        self.last_gain = (0.0, 0.0)                 # Kalman gain [k0, k1] of the last reading (for tuning)
        self.rejects: list = []                     # gated readings in a row, for re-acquisition, cm

    @property
    def alive(self) -> bool:
        return self.distance_cm is not None


    # ------------------------------------------------------------------
    def _start(self, z_cm: float, t_s: float) -> None:
        self.distance_cm = float(z_cm)
        self.velocity_cm_s = 0.0
        self.p00 = self.sigma_r_cm ** 2
        self.p01 = 0.0
        self.p11 = self.v0_sigma_cm_s ** 2
        self.t_s = t_s
        self.t_reading_s = t_s
        self.rejects = []

    def _as_reading(self, z_cm) -> Optional[float]:
        """The reading as a float, or None when it is missing: None, NaN,
        +/-inf, or negative on a distance channel."""
        if z_cm is None:
            return None
        z_cm = float(z_cm)
        if not math.isfinite(z_cm) or (z_cm < 0 and self.negative_is_missing):
            return None
        return z_cm

    def _clamped(self, value_cm: float) -> float:
        """A returned value inside range_cm, if there is one."""
        if self.range_cm is None:
            return value_cm
        low_cm, high_cm = self.range_cm
        return min(max(value_cm, low_cm), high_cm)

    def _gated(self, z_cm: float, t_s: float) -> bool:
        """True if z_cm is a spike: its normalised innovation squared, against
        the state predicted to t_s, is above nis_gate. Changes nothing."""
        if self.nis_gate is None:
            return False
        dt = max(0.0, t_s - self.t_s)
        dt2 = dt * dt
        q = self.sigma_a_cm_s2 ** 2
        predicted_cm = self.distance_cm + self.velocity_cm_s * dt
        p00 = self.p00 + 2.0 * dt * self.p01 + dt2 * self.p11 + q * dt2 * dt2 / 4.0
        s = p00 + self.sigma_r_cm ** 2
        nu = z_cm - predicted_cm
        return nu * nu / s > self.nis_gate

    def _reacquires(self, z_cm: float) -> bool:
        """Note one gated reading; True once REACQ_READINGS of them in a row
        agree to within REACQ_SPREAD_CM (the sensing model's rule)."""
        self.rejects = (self.rejects + [z_cm])[-REACQ_READINGS:]
        return (len(self.rejects) >= REACQ_READINGS
                and max(self.rejects) - min(self.rejects) <= REACQ_SPREAD_CM)

    def _predict_to(self, t_s: float) -> None:
        dt = t_s - self.t_s
        if dt <= 0.0:
            return
        q = self.sigma_a_cm_s2 ** 2
        dt2 = dt * dt
        # x = F x ; P = F P F^T + Q
        self.distance_cm += self.velocity_cm_s * dt
        p00 = self.p00 + 2.0 * dt * self.p01 + dt2 * self.p11 + q * dt2 * dt2 / 4.0
        p01 = self.p01 + dt * self.p11 + q * dt2 * dt / 2.0
        p11 = self.p11 + q * dt2
        self.p00, self.p01, self.p11 = p00, p01, p11
        self.t_s = t_s

    def update(self, z_cm: Optional[float], t_s: float) -> Optional[float]:
        """Feed one reading taken at t_s (s). None, NaN, +/-inf, or a negative
        value unless negative_is_missing is off, is a missing reading; so is a
        spike the gate drops. A missing reading leaves the state at the last
        accepted reading, and the result is predict() to t_s, so it never
        extrapolates past max_lead_s. Returns the distance estimate at t_s,
        or None when there is no track. A non-finite t_s changes nothing."""
        if not math.isfinite(t_s):
            return self.predict() if self.alive else None
        z_cm = self._as_reading(z_cm)
        if self.alive and t_s - self.t_reading_s > self.gap_reset_s:
            self.reset()
        if not self.alive:
            if z_cm is None:
                return None
            self._start(z_cm, t_s)
            return self._clamped(self.distance_cm)

        if z_cm is not None and self._gated(z_cm, t_s):
            if not self._reacquires(z_cm):
                return self.predict(t_s - self.t_s)
            self._start(z_cm, t_s)         # the player really moved
            return self._clamped(self.distance_cm)
        if z_cm is None:
            return self.predict(t_s - self.t_s)

        self._predict_to(t_s)
        self.rejects = []
        r = self.sigma_r_cm ** 2
        s = self.p00 + r
        nu = z_cm - self.distance_cm
        k0 = self.p00 / s
        k1 = self.p01 / s
        self.last_gain = (k0, k1)
        self.distance_cm += k0 * nu
        self.velocity_cm_s += k1 * nu
        if self.v_max_cm_s is not None:
            self.velocity_cm_s = min(max(self.velocity_cm_s, -self.v_max_cm_s), self.v_max_cm_s)
        # Joseph form (I-KH) P (I-KH)^T + K R K^T, written out for H = [1, 0]
        a = 1.0 - k0
        p00 = a * a * self.p00 + k0 * k0 * r
        p01 = a * (self.p01 - k1 * self.p00) + k0 * k1 * r
        p11 = self.p11 - 2.0 * k1 * self.p01 + k1 * k1 * self.p00 + k1 * k1 * r
        self.p00, self.p01, self.p11 = p00, p01, p11
        self.t_reading_s = t_s
        if not all(map(math.isfinite, (self.distance_cm, self.velocity_cm_s,
                                       self.p00, self.p01, self.p11))):
            self.reset()                   # overflowed on an absurd reading: drop the track
            return None
        return self._clamped(self.distance_cm)

    def predict(self, ahead_s: float = 0.0) -> Optional[float]:
        """Predicted distance ahead_s seconds after the last accepted reading,
        without changing the state. The lead is clamped to [0, max_lead_s]
        (a NaN lead counts as 0) and the result to range_cm. None when there
        is no track."""
        if not self.alive:
            return None
        lead_s = min(max(0.0, ahead_s), self.max_lead_s)
        return self._clamped(self.distance_cm + self.velocity_cm_s * lead_s)

    def predict_at(self, now_s: float, lead_s: float = 0.0) -> Optional[float]:
        """Predicted distance at now_s + lead_s (s), without changing the
        state; the total lead from the last accepted reading is capped at
        max_lead_s.
        None when there is no track, or when now_s is more than gap_reset_s
        after the last reading (update() would drop the track then)."""
        if not self.alive or now_s - self.t_reading_s > self.gap_reset_s:
            return None
        return self.predict(now_s + lead_s - self.t_s)


class PathPredictor:
    """One ConstantVelocityTracker per channel, indexed 0..n-1.

    Plain data: channel index, distance in cm (None or negative = missing),
    time in s. Knows nothing about node ids or messages.

    Its trackers take RAW readings, with no slew gate or median in front, so
    the spike gate and the velocity limit are on unless tracker_kwargs says
    otherwise."""

    def __init__(self, channel_count: int, **tracker_kwargs):
        if channel_count <= 0:
            raise ValueError("channel_count must be positive")
        tracker_kwargs.setdefault("nis_gate", DEFAULT_NIS_GATE)
        tracker_kwargs.setdefault("v_max_cm_s", DEFAULT_V_MAX_CM_S)
        self.trackers = [ConstantVelocityTracker(**tracker_kwargs)
                         for _ in range(channel_count)]

    def reset(self) -> None:
        """Drop every track."""
        for tracker in self.trackers:
            tracker.reset()

    def reset_channel(self, channel: int) -> None:
        """Drop one channel's track (e.g. its sensor went offline)."""
        self.trackers[channel].reset()

    def update(self, channel: int, distance_cm: Optional[float], t_s: float) -> None:
        """Feed one new reading to one channel's tracker."""
        self.trackers[channel].update(distance_cm, t_s)

    def predicted_cm(self, now_s: float, lead_s: float = 0.0) -> list:
        """Each channel's predicted distance at now_s + lead_s, in cm, or
        None for a channel with no live track (see predict_at)."""
        return [tracker.predict_at(now_s, lead_s) for tracker in self.trackers]


# =============================================================================
# Steady-state analysis (for tuning and tests)
# =============================================================================

def alpha_beta_closed_form(tracking_index: float) -> tuple[float, float]:
    """Kalata (1984): steady-state alpha, beta of this filter at a fixed
    sample interval dt, from the tracking index sigma_a dt^2 / sigma_r.
    The steady-state gain is K = [alpha, beta / dt]."""
    lam = tracking_index
    root = math.sqrt(lam * lam + 8.0 * lam)
    alpha = -(lam * lam + 8.0 * lam - (lam + 4.0) * root) / 8.0
    beta = (lam * lam + 4.0 * lam - lam * root) / 4.0
    return alpha, beta
