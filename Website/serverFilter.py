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
"""

from __future__ import annotations

from typing import Optional, Sequence

from filterRules import (
    GRID_SIZE,
    CoordinatePipeline,
    FilteredCoordinate,
    PlayArea,
    UltrasonicArrayGeometry,
)

# Environment variable that turns server-side filtering on. Off by default so
# the server behaves exactly as before until the team switches it on.
SERVER_FILTERING_ENV = "SERVER_FILTERING"
SERVER_FILTERING_ON_VALUES = ("1", "true", "yes", "on")


def server_filtering_enabled(environ) -> bool:
    """True only when the flag is explicitly set to an on value."""
    value = str(environ.get(SERVER_FILTERING_ENV, "")).strip().lower()
    return value in SERVER_FILTERING_ON_VALUES


class ServerFilterStage:
    """One pipeline, fed from up to three nodes mapped to left/centre/right.

    Plain data in: a node id, a distance in cm (or None) and a time in ms.
    Knows nothing about sockets or the node dicts in app.py.
    """

    def __init__(self, pipeline: Optional[CoordinatePipeline] = None):
        self.pipeline = pipeline or CoordinatePipeline(UltrasonicArrayGeometry())
        self.sensor_slots: list = [None] * GRID_SIZE      # node id per L, C, R
        self._latest_cm: dict = {}                        # node id -> raw cm or None
        self.latest: Optional[FilteredCoordinate] = None

    def assign_slots(self, slots: Sequence) -> None:
        """Set which node id is left, centre and right. Resets the pipeline,
        since filtered history from a different mapping is meaningless."""
        slots = list(slots)
        if len(slots) != GRID_SIZE:
            raise ValueError(f"need {GRID_SIZE} slots, got {len(slots)}")
        self.sensor_slots = slots
        self.pipeline.reset()
        self.latest = None

    def set_calibration(self, per_column: Sequence[tuple]) -> None:
        """Apply the six calibrated points as (near_cm, far_cm) per column."""
        self.pipeline.set_area(PlayArea.calibrated(per_column))

    def on_missing(self, node_id) -> None:
        """A node went offline: its channel has no reading from now on."""
        if node_id in self._latest_cm:
            self._latest_cm[node_id] = None

    def on_reading(self, node_id, distance_cm: Optional[float],
                   now_ms: float) -> Optional[FilteredCoordinate]:
        """Run the chain once for one new reading. Returns None, and runs
        nothing, if the node is not assigned to a slot."""
        if node_id not in self.sensor_slots:
            return None
        self._latest_cm[node_id] = distance_cm

        sample = [self._latest_cm.get(slot) for slot in self.sensor_slots]
        # A slot with no node, or a node that went offline, is a genuine
        # "no reading" (None), which is safe to pass every time: it never
        # enters a median window. Only the reporting node's channel is fresh.
        fresh = [slot == node_id or sample[i] is None
                 for i, slot in enumerate(self.sensor_slots)]
        self.latest = self.pipeline.update(sample, now_ms, fresh=fresh)
        return self.latest
