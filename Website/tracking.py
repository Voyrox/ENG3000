"""
tracking.py - per-sensor constant-velocity Kalman tracker for path prediction.

NOT WIRED YET: nothing in app.py, serverFilter.py or the browser uses this
module. It is the building block for issue #18 (path prediction); wiring it
into the server pipeline is a later change. The median in filterRules.py
remains the rule owner for filtering until then.

One tracker per sensor channel. State is [distance_cm, velocity_cm_s],
updated only when that channel reports. Discrete white-noise acceleration
model (Bar-Shalom et al. 2001, sec. 6.3.2):

    x_k = F x_{k-1} + w_k,   F = [[1, dt], [0, 1]]
    Q   = sigma_a^2 [[dt^4/4, dt^3/2], [dt^3/2, dt^2]]
    z_k = H x_k + n_k,       H = [1, 0],  R = sigma_r^2

A median of N readings lags a ramp by (N - 1) / 2 samples; the velocity
state lets this filter track a ramp with zero steady-state lag and predict
ahead through missing readings.

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


class ConstantVelocityTracker:
    """Constant-velocity Kalman filter for one distance channel, in cm.

    update(z_cm, t_s) feeds one reading (None or negative = no echo, which
    is missing, never 0 cm) taken at t_s seconds; dt comes from the
    timestamps. predict(ahead_s) returns the extrapolated distance without
    changing the state, or None when there is no track."""

    def __init__(self,
                 sigma_a_cm_s2: float = DEFAULT_SIGMA_A_CM_S2,  # process noise (acceleration), cm/s^2
                 sigma_r_cm: float = DEFAULT_SIGMA_R_CM,        # measurement noise SD, cm
                 gap_reset_s: float = DEFAULT_GAP_RESET_S,      # drop the track after this long without a reading, s
                 v0_sigma_cm_s: float = DEFAULT_V0_SIGMA_CM_S):  # initial velocity SD of a new track, cm/s
        if sigma_a_cm_s2 <= 0 or sigma_r_cm <= 0:
            raise ValueError("noise levels must be positive")
        if gap_reset_s <= 0:
            raise ValueError("gap_reset_s must be positive")
        self.sigma_a_cm_s2 = sigma_a_cm_s2
        self.sigma_r_cm = sigma_r_cm
        self.gap_reset_s = gap_reset_s
        self.v0_sigma_cm_s = v0_sigma_cm_s
        self.reset()

    # ------------------------------------------------------------------
    def reset(self) -> None:
        """Drop the track."""
        self.distance_cm: Optional[float] = None   # estimate at time t_s
        self.velocity_cm_s = 0.0
        self.p00 = self.p01 = self.p11 = 0.0        # covariance [[p00, p01], [p01, p11]]
        self.t_s: Optional[float] = None            # time of the last predict/update
        self.t_reading_s: Optional[float] = None    # time of the last accepted reading
        self.last_gain = (0.0, 0.0)                 # Kalman gain [k0, k1] of the last reading (for tuning)

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
        """Feed one reading taken at t_s (s). None or a negative value is a
        missing reading: the state is only predicted forward. Returns the
        distance estimate at t_s, or None when there is no track."""
        if z_cm is not None and z_cm < 0:
            z_cm = None
        if self.alive and t_s - self.t_reading_s > self.gap_reset_s:
            self.reset()
        if not self.alive:
            if z_cm is None:
                return None
            self._start(z_cm, t_s)
            return self.distance_cm

        self._predict_to(t_s)
        if z_cm is None:
            return self.distance_cm

        r = self.sigma_r_cm ** 2
        s = self.p00 + r
        nu = z_cm - self.distance_cm
        k0 = self.p00 / s
        k1 = self.p01 / s
        self.last_gain = (k0, k1)
        self.distance_cm += k0 * nu
        self.velocity_cm_s += k1 * nu
        # Joseph form (I-KH) P (I-KH)^T + K R K^T, written out for H = [1, 0]
        a = 1.0 - k0
        p00 = a * a * self.p00 + k0 * k0 * r
        p01 = a * (self.p01 - k1 * self.p00) + k0 * k1 * r
        p11 = self.p11 - 2.0 * k1 * self.p01 + k1 * k1 * self.p00 + k1 * k1 * r
        self.p00, self.p01, self.p11 = p00, p01, p11
        self.t_reading_s = t_s
        return self.distance_cm

    def predict(self, ahead_s: float = 0.0) -> Optional[float]:
        """Predicted distance ahead_s seconds after the last update, without
        changing the state. None when there is no track."""
        if not self.alive:
            return None
        return self.distance_cm + self.velocity_cm_s * max(0.0, ahead_s)


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
