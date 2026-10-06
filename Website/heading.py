"""
heading.py - where a moving player was heading when a node lost them
(Aaron, 6 Oct).

"Instead of sweeping in a random direction to find someone when they are
lost they should firstly identify if the user was most likely standing
still then they should identify the last cell of highest confidence and
then sweeep back to that cell. If the user has moved or is moving." For a
player moving at the loss he chose (6 Oct): "Use your last movement
direction and speed to predict the cell you were walking into, aim the lost
node there, and sweep outward from that cell if it finds nothing." A still
player is search.py's: the cell the nodes' readings put them in most often
over the last few seconds.

The game sends its position track to the server as track:update - moving
(the game's moving/still detector, stepMotion()), the track's position
(x, y, cm) and velocity (vx, vy, cm/s), and ageMs, how long ago the track
last took a reading. track_from_event() turns that into a Track, dated in
the server's own clock. heading_target() is the cell the player is walking
into: the track's position carried on along its velocity to LEAD_S past
now, at most MAX_AHEAD_CM, brought onto the board. None when the player is
not moving or the track is too old to say (TRACK_FRESH_S), so search.py
falls back to its cell for a still player.

search.py owns the search (uni-2026-s2-93): it asks heading_target() first
and aims the lost node at the cell's centre. Standard library only, apart
from the shared geometry.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Tuple

from filterRules import PlayArea

# A track that last took a reading longer ago than this says nothing about
# where the player is now: the game's line of sight gives up after 1.5 s
# (LOS_TRACK_TIMEOUT_MS in game.js).
TRACK_FRESH_S = 1.5
# How far past now the lost node should look: its LOOK swings the servo
# (4 ms a degree) and the node may only read again at its next turn.
LEAD_S = 0.5
# At most this far on from the track's position, about one cell: a guess at
# the next cell, not a jump across the board on a noisy velocity.
MAX_AHEAD_CM = 50.0


@dataclass(frozen=True)
class Track:
    """The game's position track, in cm and cm/s; at_s is when it last took
    a reading, in the server's clock (seconds)."""
    moving: bool
    x_cm: float
    y_cm: float
    vx_cm_s: float
    vy_cm_s: float
    at_s: float


def _finite(value) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def track_from_event(message: dict, now_s: float) -> Optional[Track]:
    """track:update -> Track, or None when it carries no usable track.
    {moving, x, y, vx, vy, ageMs}: a missing or unusable velocity is 0, a
    missing ageMs is 0 (the track took a reading just now)."""
    if not isinstance(message, dict) or not isinstance(message.get("moving"), bool):
        return None
    x, y = _finite(message.get("x")), _finite(message.get("y"))
    if x is None or y is None:
        return None
    vx = _finite(message.get("vx")) or 0.0
    vy = _finite(message.get("vy")) or 0.0
    age_ms = _finite(message.get("ageMs"))
    age_s = max(0.0, age_ms / 1000.0) if age_ms is not None else 0.0
    return Track(message["moving"], x, y, vx, vy, now_s - age_s)


def predicted_point(track: Track, now_s: float) -> Tuple[float, float]:
    """Where the track's player is at LEAD_S past now, carried on along its
    velocity from its last reading, at most MAX_AHEAD_CM from it."""
    dt = max(0.0, now_s - track.at_s) + LEAD_S
    dx, dy = track.vx_cm_s * dt, track.vy_cm_s * dt
    step = math.hypot(dx, dy)
    if step > MAX_AHEAD_CM:
        dx, dy = dx * MAX_AHEAD_CM / step, dy * MAX_AHEAD_CM / step
    return track.x_cm + dx, track.y_cm + dy


def heading_target(track: Optional[Track], now_s: float,
                   area: PlayArea) -> Optional[Tuple[int, int]]:
    """The cell (gx, gy) a moving player is walking into (predicted_point(),
    brought onto the board), or None: no track, a still player, or a track
    older than TRACK_FRESH_S."""
    if track is None or not track.moving or now_s - track.at_s > TRACK_FRESH_S:
        return None
    x, y = predicted_point(track, now_s)
    gx = area.column_at(min(max(x, 0.0), area.width_cm))
    near, far = area.per_column[gx]
    return gx, area.row_for(gx, min(max(y, near), far))
