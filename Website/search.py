"""
search.py - a node that loses the player looks where they most likely are
before it sweeps (Aaron, 6 Oct).

"If a node gets lost it should go back to the previous cell that had the
highest confidence of having a player there last, and only once it has
checked that should it go into panic mode and start trying to find the
player." He chose (6 Oct):
  - each node on its own, from its first lost reading;
  - the one cell with the highest confidence, not several in turn;
  - far hold first: after a far echo the node holds where it last heard
    the player, then goes to the cell, then sweeps;
  - the server re-sends LOOK, with no firmware change.

The cell. The game's cell confidence map (cells:confidence, nine scores,
index gx * 3 + gy; uni-2026-s2-ea's agent/cell-confidence) says how likely
each cell is to hold the player; the search goes to the highest. Ties go to
the cell the game shows. Until the map arrives, or while every score is 0,
the target is the cell the game last showed this round (game:status's
cursor). No round on screen, or no game page: no target, and the node
sweeps as it always has, asking again at each lost reading.

A search, for one node:
  1. Its first lost reading starts it. After a far echo (FAR_RANGE_CM or
     more) with Far hold on, the firmware first keeps the servo still for
     FAR_HOLD_PAIRS lost readings, so the search starts on the last of those
     instead (see "Far hold" below).
  2. The node is sent LOOK <deg>, the bearing from it to the cell's centre,
     within its servo's limits.
  3. Each lost reading taken at that bearing is one check. The firmware
     sweeps a step after every lost reading, so after each check short of
     CHECK_READINGS the LOOK is sent again to bring it back.
  4. A found or half-found reading ends the search: the firmware tracks
     whatever it heard, as usual.
  5. After CHECK_READINGS checks, or SEARCH_TIMEOUT_S, nothing more is
     sent and the firmware's sweep takes over ("panic"). The node is not
     searched for again until it has found the player.

A LOOK may reach a node that does not hold the scan turn: it swings while it
is quiet, and its next turn starts at the cell.

Far hold (src/Config.h FAR_RANGE_CM, FAR_HOLD_PAIRS; Scanner::move). After
an echo at least FAR_RANGE_CM out, a lost reading keeps the servo where it is
for up to FAR_HOLD_PAIRS lost readings, except against either servo stop.
Every LOOK, this one's or the handover's, makes the firmware forget that
echo, and so does this module. The constants here must follow Config.h.

Not thread-safe: app.py calls it under state_lock. Standard library only,
apart from the shared geometry.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, Optional, Sequence, Tuple

from filterRules import GRID_SIZE, PlayArea
from handover import ROOM_LEARNING, bearing_deg, node_x_cm

CHECK_READINGS = 3        # lost readings at the cell before the node is left to sweep
AT_CELL_DEG = 1           # a reading this close to the LOOK's angle was read at the cell
LOOK_RETRY_S = 0.5        # re-send a LOOK not yet acted on after this long
SEARCH_TIMEOUT_S = 5.0    # a search that has not finished by then is given up
GAME_FRESH_S = 2.0        # no game:status for this long: the game page is gone

# src/Config.h: the far hold, and each mount's servo limits (min, max).
FAR_RANGE_CM = 100.0
FAR_HOLD_PAIRS = 3
SERVO_LIMITS = {"LEFT": (40, 160), "RIGHT": (30, 140)}

# Scan states, as the firmware reports them (app.py parse_scan_state()).
FOUND, HALF_FOUND, LOST = 0, 1, 2

ROW_NAMES = ("front", "middle", "back")
COLUMN_NAMES = ("left", "centre", "right")


def cell_name(cell: Tuple[int, int]) -> str:
    """"back left" for (0, 2): gy 0 is the row nearest the nodes."""
    gx, gy = cell
    return f"{ROW_NAMES[gy]} {COLUMN_NAMES[gx]}"


@dataclass(frozen=True)
class SearchLook:
    """One LOOK to send: aim node_id at the centre of cell."""
    node_id: int
    degrees: int
    cell: Tuple[int, int]
    checks: int               # lost readings already taken at the cell

    @property
    def command(self) -> str:
        return f"LOOK {self.degrees}"


class _Node:
    __slots__ = ("last_echo_cm", "lost_streak", "state", "cell", "target_deg",
                 "checks", "started_at", "look_sent_at")

    def __init__(self):
        self.last_echo_cm = None   # its latest found or half-found distance, for far hold
        self.lost_streak = 0       # lost readings in a row
        self.state = "ready"       # "ready" | "checking" | "sweeping"
        self.cell = None           # the cell being checked
        self.target_deg = None     # the LOOK's angle
        self.checks = 0
        self.started_at = None
        self.look_sent_at = None

    def ready(self):
        self.state = "ready"
        self.cell = self.target_deg = self.started_at = self.look_sent_at = None
        self.checks = 0


class Search:
    def __init__(self, enabled: bool = True, area: Optional[PlayArea] = None):
        self.enabled = enabled
        self.area = area or PlayArea.default()
        self._nodes: Dict[int, _Node] = {}
        self._scores: Optional[Tuple[float, ...]] = None
        self._shown_cell: Optional[Tuple[int, int]] = None
        self._game_at: Optional[float] = None    # the latest game:status with a round on screen

    # --- What the game says ---------------------------------------------------------

    def game_status(self, cursor: Optional[dict], now_s: float) -> None:
        """game:status's cursor: None with no round on screen. The cell is
        the sensor cursor's (gx, gy), the cell the game shows."""
        if not isinstance(cursor, dict):
            self._game_at = None
            self._shown_cell = None
            return
        self._game_at = now_s
        sensor = cursor.get("sensor")
        if isinstance(sensor, dict):
            cell = (sensor.get("gx"), sensor.get("gy"))
            if all(isinstance(v, int) and not isinstance(v, bool) and 0 <= v < GRID_SIZE
                   for v in cell):
                self._shown_cell = cell

    def set_scores(self, scores: Sequence[float]) -> None:
        """cells:confidence: nine scores, index gx * GRID_SIZE + gy."""
        values = tuple(float(s) for s in scores)
        if len(values) != GRID_SIZE * GRID_SIZE or not all(math.isfinite(v) for v in values):
            raise ValueError(f"need {GRID_SIZE * GRID_SIZE} finite scores")
        self._scores = values

    def set_calibration(self, per_column: Sequence[tuple]) -> None:
        """calibration:update's (near, far) per column, for the cells' depths."""
        self.area = PlayArea.calibrated(per_column, self.area.width_cm)

    def reset(self) -> None:
        """A new round: nothing from the last one says where the player is."""
        self._scores = None
        self._shown_cell = None
        for node in self._nodes.values():
            node.ready()

    def target_cell(self, now_s: float) -> Optional[Tuple[int, int]]:
        """The cell a lost node checks, or None with no round on screen."""
        if self._game_at is None or now_s - self._game_at > GAME_FRESH_S:
            return None
        if self._scores is not None and max(self._scores) > 0:
            best = max(self._scores)
            tied = [divmod(i, GRID_SIZE) for i, s in enumerate(self._scores) if s == best]
            return self._shown_cell if self._shown_cell in tied else tied[0]
        return self._shown_cell

    def cell_centre(self, cell: Tuple[int, int]) -> Tuple[float, float]:
        gx, gy = cell
        near, far = self.area.per_column[gx]
        return self.area.column_centre_cm(gx), near + (gy + 0.5) * (far - near) / GRID_SIZE

    def bearing_to(self, role: str, cell: Tuple[int, int]) -> int:
        """The LOOK angle that points the role's node at the cell's centre,
        within its servo's limits (the firmware would stop there anyway)."""
        low, high = SERVO_LIMITS[role]
        bearing = bearing_deg(node_x_cm(role, self.area), self.cell_centre(cell))
        return int(round(min(high, max(low, bearing))))

    # --- Readings -------------------------------------------------------------------

    def forget(self, node_id: int) -> None:
        """The node went offline."""
        self._nodes.pop(node_id, None)

    def looked(self, node_id: int) -> None:
        """Another LOOK (the handover's) went to the node: the firmware has
        forgotten its last echo, so no far hold follows."""
        node = self._nodes.get(node_id)
        if node is not None:
            node.last_echo_cm = None

    def checking(self, node_id: int) -> bool:
        """Whether the search is aiming this node, so nothing else should."""
        node = self._nodes.get(node_id)
        return node is not None and node.state == "checking"

    def record(self, node_id: int, role: Optional[str], state: Optional[int],
               distance_cm: Optional[float], angle_deg: Optional[float], now_s: float,
               room: Optional[int] = None, far_hold: bool = True,
               held: bool = False) -> Optional[SearchLook]:
        """One reading from a node; returns the LOOK to send, if any.

        state is the firmware's scan state (None from firmware that does not
        say: then an echo is found and no echo is lost). distance_cm is the
        nearer of its two sensors' echoes, which the far hold goes by
        (app.py parse_nearest_echo_cm()). far_hold is the Far hold switch,
        held is calibration holding the servos at 90.
        """
        node = self._nodes.setdefault(node_id, _Node())
        if state is None:
            state = LOST if distance_cm is None or distance_cm <= 0 else FOUND

        if state != LOST:
            node.last_echo_cm = distance_cm
            node.lost_streak = 0
            node.ready()
            return None

        node.lost_streak += 1
        if (not self.enabled or held or room == ROOM_LEARNING
                or SERVO_LIMITS.get(role) is None or angle_deg is None):
            node.ready()
            return None

        if node.state == "ready":
            if self._far_holding(node, role, angle_deg, far_hold):
                return None
            cell = self.target_cell(now_s)
            if cell is None:
                # Nowhere to look yet: it sweeps, and its next lost reading
                # asks again (the other node may have found the player).
                return None
            node.state = "checking"
            node.cell = cell
            node.target_deg = self.bearing_to(role, cell)
            node.started_at = now_s
            node.checks = 0

        if node.state != "checking":
            return None
        if now_s - node.started_at > SEARCH_TIMEOUT_S:
            node.state = "sweeping"
            return None
        at_cell = abs(angle_deg - node.target_deg) <= AT_CELL_DEG
        if at_cell:
            node.checks += 1
            if node.checks >= CHECK_READINGS:
                node.state = "sweeping"
                return None
        elif node.look_sent_at is not None and now_s - node.look_sent_at < LOOK_RETRY_S:
            # Read before the last LOOK took effect: it is on its way.
            return None
        node.look_sent_at = now_s
        node.last_echo_cm = None
        return SearchLook(node_id=node_id, degrees=node.target_deg, cell=node.cell,
                          checks=node.checks)

    @staticmethod
    def _far_holding(node: _Node, role: str, angle_deg: float, far_hold: bool) -> bool:
        """Whether the firmware's far hold keeps the servo still after this
        lost reading, the node.lost_streak-th in a row. The search starts on
        the last one it holds for, so the next reading is at the cell."""
        if not far_hold or node.last_echo_cm is None or node.last_echo_cm < FAR_RANGE_CM:
            return False
        low, high = SERVO_LIMITS[role]
        if angle_deg <= low or angle_deg >= high:
            return False
        return node.lost_streak < FAR_HOLD_PAIRS

    # --- Display --------------------------------------------------------------------

    def status(self, node_id: int) -> Optional[dict]:
        """A node's search for nodes:update: None unless it is checking a cell
        or sweeping after one."""
        node = self._nodes.get(node_id)
        if not self.enabled or node is None or node.state == "ready":
            return None
        out = {"state": node.state, "checks": node.checks, "of": CHECK_READINGS}
        if node.cell is not None:
            out["cell"] = list(node.cell)
            out["name"] = cell_name(node.cell)
        return out
