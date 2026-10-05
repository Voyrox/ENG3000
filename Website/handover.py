"""
handover.py - when one scanner node is sure where the player is, aim the other.

Each scanner node reports its distance to the player and the servo angle it
read at, which puts the player at a point (scanner_point() in filterRules.py).

Confidence. Over the last WINDOW_S, a node's score is the share of its
readings that land inside the play area AND within CLUSTER_RADIUS_CM of the
median of those points. Dropped echoes count against it, but the odd one does
not reset it. The node is CONFIDENT once the score reaches CONFIDENT_SHARE, it
has at least MIN_READINGS readings in the window, and it has been reporting
for at least WINDOW_S, so a handful of steady readings straight after it
connects is not enough. A walking player is not "at one place" and never makes
a node confident. spread_cm, the "plus or minus", is the RMS distance of the
steady points from that median.

Handover. While one node is confident and the other is not seeing the player
there, the other one is aimed at that point with LOOK <deg>, the bearing from
it to the point. It is re-aimed whenever that bearing moves by more than
REAIM_DEG, and left to its own tracking once its own latest reading agrees
(within AGREE_CM). LOOK is not a hold: the node tracks, steers and sweeps from
the new angle as usual. Both confident, or neither: nothing is sent.

Timing. The nodes take turns (coordinator_loop in app.py), and a node only
reads while it holds the turn. So in WINDOW_S a node reads for about half of
it; the score is a share of its own readings, so the other node's turns
neither help nor hurt. A player who walks up and stands still has to be seen
for about CONFIDENT_SHARE of WINDOW_S (4 of the 5 s) before the readings from
before they arrived stop outweighing them.

A LOOK only ever goes to a node that does not hold the turn, so its servo
swings while it is quiet. The confident node's point is up to one turn old
when it is sent, which does not matter for a player who has stood still long
enough to count.

The empty room (agent/empty-room firmware, readings with a "room" field). A
node that is learning the room (room 1) is sweeping on purpose: its readings
are not counted and it is never aimed. A node that reports a room which is not
learnt yet (room 0) cannot become confident, because before the room is learnt
a chair is the steadiest "player" there is. Firmware without the field is
taken as it is.

Not thread-safe: app.py calls it under state_lock. Standard library only,
apart from filterRules for the shared geometry.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass
from statistics import median
from typing import Dict, List, Optional, Tuple

from filterRules import PlayArea, scanner_point

WINDOW_S = 5.0            # how long a node must have seen the player in one place
CONFIDENT_SHARE = 0.8     # share of its readings in the window that must be steady
CLUSTER_RADIUS_CM = 20.0  # how far from the median point a steady reading may be
MIN_READINGS = 8          # fewer than this in the window is too little to go on
AGREE_CM = 30.0           # the other node has found the player within this
AGREE_FRESH_S = 2.5       # ...going by its latest in-play reading, if this recent
REAIM_DEG = 5.0           # re-aim when the bearing to the point moves by more

# The empty room's "room" field.
ROOM_NOT_LEARNT = 0
ROOM_LEARNING = 1

# Which slot of [left, centre, right] each role's node sits in front of.
ROLE_SLOTS = {"LEFT": 0, "RIGHT": 2}


@dataclass(frozen=True)
class Confidence:
    """How sure one node is of where the player is, over the last WINDOW_S."""
    score: Optional[float]                  # 0-1; None without a role to place it by
    spread_cm: Optional[float]              # RMS distance of the steady points from the median
    point: Optional[Tuple[float, float]]    # that median, (x_cm, y_cm)
    confident: bool
    readings: int


@dataclass(frozen=True)
class Look:
    """One LOOK to send: aim node_id at the point source_id is confident of."""
    node_id: int
    degrees: int
    source_id: int
    point: Tuple[float, float]
    spread_cm: float

    @property
    def command(self) -> str:
        return f"LOOK {self.degrees}"


NO_CONFIDENCE = Confidence(score=None, spread_cm=None, point=None, confident=False, readings=0)


class _Node:
    __slots__ = ("readings", "first_reading_at", "last_angle", "last_reading_at", "room",
                 "look_deg", "look_sent_at", "following")

    def __init__(self):
        self.readings = deque()      # (t_s, distance_cm or None, angle_deg or None)
        self.first_reading_at = None  # since it connected, or finished learning the room
        self.last_angle = None       # the servo angle of its latest reading
        self.last_reading_at = None
        self.room = None             # its latest "room" field, None if it sends none
        self.look_deg = None         # the last LOOK it was sent in this handover
        self.look_sent_at = None
        self.following = None        # the confident node it is being aimed by


def node_x_cm(role: Optional[str], area: PlayArea) -> Optional[float]:
    slot = ROLE_SLOTS.get(role)
    return None if slot is None else area.column_centre_cm(slot)


def angle_off(angle: Optional[float], bearing: float) -> float:
    """How far angle is from bearing, in degrees; infinite when angle is unknown."""
    return math.inf if angle is None else abs(angle - bearing)


def bearing_deg(node_x: float, point: Tuple[float, float]) -> float:
    """The servo angle that points a node at node_x straight at point.

    The inverse of scanner_point(): 90 is straight out, larger turns towards
    screen-right (larger x), as the rig's servos turn (the centre test, 4 Oct).
    """
    x, y = point
    return 90.0 + math.degrees(math.atan2(x - node_x, y))


class Handover:
    def __init__(self, steer: bool = True, area: Optional[PlayArea] = None):
        # steer=False still works out every node's confidence, for display,
        # but never sends a LOOK (HANDOVER=0 in app.py).
        self.steer = steer
        self.area = area or PlayArea.default()
        self._nodes: Dict[int, _Node] = {}

    # --- Input ------------------------------------------------------------------

    def record(self, node_id: int, distance_cm: Optional[float],
               angle_deg: Optional[float], now_s: float,
               room: Optional[int] = None) -> None:
        """One reading from a node. A negative distance is no echo."""
        node = self._nodes.setdefault(node_id, _Node())
        node.room = room
        if room == ROOM_LEARNING:
            node.readings.clear()
            node.first_reading_at = None
            return
        if node.first_reading_at is None:
            node.first_reading_at = now_s
        node.readings.append((now_s, distance_cm, angle_deg))
        node.last_angle = angle_deg
        node.last_reading_at = now_s
        while node.readings and now_s - node.readings[0][0] > WINDOW_S:
            node.readings.popleft()

    def forget(self, node_id: int) -> None:
        """The node went offline: nothing it said still holds."""
        self._nodes.pop(node_id, None)

    # --- Confidence ---------------------------------------------------------------

    def _point(self, role, distance_cm, angle_deg) -> Optional[Tuple[float, float]]:
        """Where a reading puts the player, or None if not inside the play area."""
        node_x = node_x_cm(role, self.area)
        if node_x is None or distance_cm is None or distance_cm <= 0:
            return None
        x, y = scanner_point(node_x, distance_cm, angle_deg)
        inside = (0.0 <= x <= self.area.width_cm
                  and self.area.ABSOLUTE_ALERT_CM <= y <= self.area.max_cm)
        return (x, y) if inside else None

    def confidence(self, node_id: int, role: Optional[str], now_s: float) -> Confidence:
        node = self._nodes.get(node_id)
        if node is None or ROLE_SLOTS.get(role) is None:
            return NO_CONFIDENCE

        window = [r for r in node.readings if now_s - r[0] <= WINDOW_S]
        placed = [(t, p) for t, p in ((t, self._point(role, d, a)) for t, d, a in window)
                  if p is not None]
        if not placed:
            return Confidence(score=0.0, spread_cm=None, point=None, confident=False,
                              readings=len(window))

        centre = (median(p[0] for _, p in placed), median(p[1] for _, p in placed))
        offsets = [math.dist(p, centre) for _, p in placed]
        steady = [d for d in offsets if d <= CLUSTER_RADIUS_CM]
        score = len(steady) / len(window)
        spread = math.sqrt(sum(d * d for d in steady) / len(steady)) if steady else None
        reporting_for = now_s - node.first_reading_at
        room_ok = node.room != ROOM_NOT_LEARNT and node.room != ROOM_LEARNING
        confident = (room_ok and reporting_for >= WINDOW_S
                     and len(window) >= MIN_READINGS and score >= CONFIDENT_SHARE)
        return Confidence(score=score, spread_cm=spread, point=centre,
                          confident=confident, readings=len(window))

    def status(self, node_id: int, role: Optional[str], now_s: float) -> Optional[dict]:
        """A node's confidence for nodes:update, or None before it has a role."""
        c = self.confidence(node_id, role, now_s)
        if c.score is None:
            return None
        node = self._nodes.get(node_id)
        return {
            "score": round(c.score, 3),
            "spread_cm": None if c.spread_cm is None else round(c.spread_cm, 1),
            "point_cm": None if c.point is None else [round(c.point[0], 1), round(c.point[1], 1)],
            "confident": c.confident,
            "following": node.following if node is not None else None,
        }

    # --- Handover -------------------------------------------------------------------

    def _agrees(self, node_id: int, role: str, point, now_s: float) -> bool:
        """Whether the node's own latest in-play reading is within AGREE_CM of point."""
        node = self._nodes.get(node_id)
        if node is None:
            return False
        for t, distance, angle in reversed(node.readings):
            if now_s - t > AGREE_FRESH_S:
                return False
            own = self._point(role, distance, angle)
            if own is not None:
                return math.dist(own, point) <= AGREE_CM
        return False

    @staticmethod
    def _pointing(node: _Node) -> Optional[float]:
        """Where a node's servo points now, as far as the server knows: where
        this handover last sent it, unless it has reported a reading since."""
        if node.look_deg is not None and (node.last_reading_at is None
                                          or node.last_reading_at <= node.look_sent_at):
            return node.look_deg
        return node.last_angle

    def commands(self, roles: Dict[int, str], has_turn: Dict[int, bool],
                 now_s: float, held: bool = False) -> List[Look]:
        """The LOOKs to send now.

        roles maps node id -> "LEFT" | "RIGHT" (calibration's assignment);
        has_turn maps node id -> whether it holds the scan turn. held is true
        while the calibration screen holds every servo at 90.
        """
        by_role = {role: node_id for node_id, role in roles.items() if role in ROLE_SLOTS}
        if held or len(by_role) < 2:
            for node in self._nodes.values():
                node.following = node.look_deg = None
            return []

        pair = (by_role["LEFT"], by_role["RIGHT"])
        conf = {node_id: self.confidence(node_id, roles[node_id], now_s) for node_id in pair}
        looks = []
        for source, target in (pair, pair[::-1]):
            follower = self._nodes.setdefault(target, _Node())
            src = conf[source]
            if (not src.confident or conf[target].confident
                    or follower.room == ROOM_LEARNING
                    or self._agrees(target, roles[target], src.point, now_s)):
                # Nothing to hand over, it has its own fix, it is busy learning
                # the room, or it has just found the player itself.
                follower.following = follower.look_deg = None
                continue
            follower.following = source
            if not self.steer or has_turn.get(target):
                # Never swing a node mid-turn: it is aimed once it halts.
                continue

            bearing = bearing_deg(node_x_cm(roles[target], self.area), src.point)
            if angle_off(self._pointing(follower), bearing) <= REAIM_DEG:
                continue
            follower.look_deg = int(round(bearing))
            follower.look_sent_at = now_s
            looks.append(Look(node_id=target, degrees=follower.look_deg, source_id=source,
                              point=src.point, spread_cm=src.spread_cm))
        return looks
