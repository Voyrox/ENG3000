"""
serverFilter.py - feeds node readings into the filterRules pipeline.

The adapter between app.py's per-node messages and CoordinatePipeline's
per-channel samples. app.py only uses it when SERVER_FILTERING is on; with the
flag off the browser (game.js) still does all the filtering, as before. While
both paths exist the JS copy in game.js stays the rule owner and filterRules.py
is the parity-tested port.

Call rate: the chain runs ONCE PER NEW READING. When one node reports, only
that node's channel receives a new sample. The other channels are passed as
not fresh, so their last reading is not fed again: re-feeding it would fill
their median windows with repeats and add lag.

Path prediction (#18): alongside the pipeline, one constant-velocity Kalman
tracker per channel (tracking.PathPredictor) gets the same fresh RAW reading
the pipeline's channel filter gets, and predicted_cm holds each channel's
predicted distance. It is published only; the coordinate, the cell vote and
the proximity alert do not read it, and the median stays the rule owner.
"""

from __future__ import annotations

from typing import Optional, Sequence

from filterRules import (
    GRID_SIZE,
    CoordinatePipeline,
    FilteredCoordinate,
    PlayArea,
    TwoSensorGeometry,
)
from tracking import PathPredictor

MS_PER_SECOND = 1000.0

# Extra lead added to every prediction for the delay between a reading and
# the screen, s. Zero until that delay is measured on the rig (the sensing
# model's hardware test list, end-to-end latency); with zero, a channel's
# prediction is its estimate extrapolated to the latest reading's time. The
# tracker caps the total lead at tracking.DEFAULT_MAX_LEAD_S either way.
PREDICTION_LEAD_S = 0.0

# Environment variable that turns server-side filtering on. Off by default so
# the server behaves exactly as before until the team switches it on.
SERVER_FILTERING_ENV = "SERVER_FILTERING"
SERVER_FILTERING_ON_VALUES = ("1", "true", "yes", "on")


def server_filtering_enabled(environ) -> bool:
    """True only when the flag is explicitly set to an on value."""
    value = str(environ.get(SERVER_FILTERING_ENV, "")).strip().lower()
    return value in SERVER_FILTERING_ON_VALUES


class ServerFilterStage:
    """One pipeline, fed from the LEFT and RIGHT nodes (the centre slot stays
    empty: the rig has two sensors) and placed by TwoSensorGeometry.

    Plain data in: a node id, a distance in cm (or None) and a time in ms.
    Knows nothing about sockets or the node dicts in app.py.
    """

    def __init__(self, pipeline: Optional[CoordinatePipeline] = None,
                 predictor: Optional[PathPredictor] = None,
                 prediction_lead_s: float = PREDICTION_LEAD_S):
        self.pipeline = pipeline or CoordinatePipeline(TwoSensorGeometry())
        self.predictor = predictor or PathPredictor(GRID_SIZE)
        self.prediction_lead_s = prediction_lead_s
        self.sensor_slots: list = [None] * GRID_SIZE      # node id per L, C, R
        self._latest_cm: dict = {}                        # node id -> raw cm or None
        self._latest_angle: dict = {}                     # node id -> servo angle or None
        self.latest: Optional[FilteredCoordinate] = None
        self.predicted_cm: list = [None] * GRID_SIZE      # L, C, R; cm or None

    def assign_slots(self, slots: Sequence) -> None:
        """Set which node id is left, centre and right ([left, None, right]
        for the two-sensor rig). Resets the pipeline
        and the trackers, since history from a different mapping is
        meaningless."""
        slots = list(slots)
        if len(slots) != GRID_SIZE:
            raise ValueError(f"need {GRID_SIZE} slots, got {len(slots)}")
        self.sensor_slots = slots
        self._latest_cm.clear()
        self._latest_angle.clear()
        self.pipeline.reset()
        self.predictor.reset()
        self.latest = None
        self.predicted_cm = [None] * GRID_SIZE

    def set_calibration(self, per_column: Sequence[tuple]) -> None:
        """Apply the calibration as (near_cm, far_cm) per column: the left and
        right as captured, the centre derived by the browser."""
        self.pipeline.set_area(PlayArea.calibrated(per_column))

    def on_missing(self, node_id) -> None:
        """A node went offline: its channel has no reading from now on, and
        its track is dropped rather than extrapolated."""
        self._latest_cm.pop(node_id, None)
        self._latest_angle.pop(node_id, None)
        for channel, slot in enumerate(self.sensor_slots):
            if slot == node_id:
                self.pipeline.reset_channel(channel)
                self.predictor.reset_channel(channel)
                self.predicted_cm[channel] = None

    def on_reading(self, node_id, distance_cm: Optional[float],
                   now_ms: float, angle_deg: Optional[float] = None
                   ) -> Optional[FilteredCoordinate]:
        """Run the chain once for one new reading. angle_deg is the servo
        angle a scanner node read it at (None for a node without one).
        Returns None, and runs nothing, if the node is not assigned to a slot."""
        if node_id not in self.sensor_slots:
            return None
        if node_id in self._latest_angle and self._latest_angle[node_id] != angle_deg:
            channel = self.sensor_slots.index(node_id)
            self.pipeline.reset_channel(channel)
            self.predictor.reset_channel(channel)
        self._latest_cm[node_id] = distance_cm
        self._latest_angle[node_id] = angle_deg

        distances = [self._latest_cm.get(slot) for slot in self.sensor_slots]
        angles = [self._latest_angle.get(slot) for slot in self.sensor_slots]
        sample = [d if a is None else (d, a) for d, a in zip(distances, angles)]
        # A slot with no node, or a node that went offline, is a genuine
        # "no reading" (None), which is safe to pass every time: it never
        # enters a median window. Only the reporting node's channel is fresh.
        fresh = [slot == node_id or distances[i] is None
                 for i, slot in enumerate(self.sensor_slots)]
        self.latest = self.pipeline.update(sample, now_ms, fresh=fresh)

        # Trackers: the same raw reading, on the reporting channel only (a
        # negative value is a missing reading, never 0 cm). Every channel's
        # prediction is then brought to this reading's time.
        now_s = now_ms / MS_PER_SECOND
        for channel, slot in enumerate(self.sensor_slots):
            if slot == node_id:
                self.predictor.update(channel, distance_cm, now_s)
        self.predicted_cm = self.predictor.predicted_cm(now_s, self.prediction_lead_s)
        return self.latest
