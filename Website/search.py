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

The cell (Aaron's pick in uni-2026-s2-0c's session, 6 Oct): the cell both
nodes' found and half-found readings put the player in most often over the
last ~3 s before the loss - robust to one bad reading just before it, and
not the cursor's cell, which lags. Each such reading is one vote for the
cell its own point is in (the node's distance plus the body radius, along
its servo angle: scanner_point(), body_centre_cm()); points off the board
vote for nothing. The votes counted are those from WINDOW_S before the
latest one, so a loss of both nodes keeps the memory; ties go to the cell
voted for last, and a cell needs MIN_VOTES, so one stray echo is not a
sighting. With no vote in the last TARGET_MAX_AGE_S there is no target, and
a lost node sweeps as it always has, asking again at each lost reading (the
other node may find the player meanwhile).

A moving player (Aaron's other pick there): the cell they were walking into,
from the game's position track (track:update; heading.py, uni-2026-s2-0c),
whenever heading_target() gives one - the track is fresh and the game says
they are moving. Otherwise the cell above. The Heading switch turns this
part off.

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
     sent and the firmware's sweep takes over ("panic").
  6. Giving up (Aaron, 6 Oct: "it gets stuck finding the player in their
     last known location; after some time it should just give up if not
     found"). A node that has given up on a cell looks again only for a
     sighting made after it gave up - votes, or a heading track, newer than
     that - never for what it knew before. Re-arming on any echo used to
     send it straight back to the same place after every stray echo the
     sweep picked up.

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

from collections import Counter, deque
from dataclasses import dataclass
from typing import Dict, Optional, Sequence, Tuple

from filterRules import GRID_SIZE, FilterConfig, PlayArea, body_centre_cm, scanner_point
from handover import ROOM_LEARNING, bearing_deg, node_x_cm
from heading import Track, heading_target

CHECK_READINGS = 3        # lost readings at the cell before the node is left to sweep
AT_CELL_DEG = 1           # a reading this close to the LOOK's angle was read at the cell
LOOK_RETRY_S = 0.5        # re-send a LOOK not yet acted on after this long
SEARCH_TIMEOUT_S = 5.0    # a search that has not finished by then is given up
WINDOW_S = 3.0            # the votes counted: this long before the latest one
MIN_VOTES = 2             # fewer votes than this for the cell: no sighting
TARGET_MAX_AGE_S = 5.0    # no vote for this long: nowhere to look

# src/Config.h: the far hold, and each mount's servo limits (min, max).
FAR_RANGE_CM = 100.0
FAR_HOLD_PAIRS = 3
SERVO_LIMITS = {"LEFT": (40, 160), "RIGHT": (30, 140)}

# Scan states, as the firmware reports them (app.py parse_scan_state()).
FOUND, HALF_FOUND, LOST = 0, 1, 2

# The body radius each distance falls short of the player's middle by.
_CONFIG = FilterConfig()

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
    by: str = "readings"      # "readings" (a still player) or "heading" (a moving one)

    @property
    def command(self) -> str:
        return f"LOOK {self.degrees}"


class _Node:
    __slots__ = ("last_echo_cm", "lost_streak", "state", "cell", "by", "target_deg",
                 "checks", "started_at", "look_sent_at", "gave_up_at", "gave_up_on")

    def __init__(self):
        self.last_echo_cm = None   # its latest found or half-found distance, for far hold
        self.lost_streak = 0       # lost readings in a row
        self.state = "ready"       # "ready" | "checking" | "sweeping"
        self.cell = None           # the cell being checked
        self.by = None             # how it was chosen: "readings" or "heading"
        self.target_deg = None     # the LOOK's angle
        self.checks = 0
        self.started_at = None
        self.look_sent_at = None
        self.gave_up_at = None     # when its last search found nobody: only newer sightings count
        self.gave_up_on = None     # the cell it gave up on

    def give_up(self, now_s):
        self.state = "sweeping"
        self.gave_up_at = now_s
        self.gave_up_on = self.cell

    def ready(self):
        self.state = "ready"
        self.cell = self.by = self.target_deg = self.started_at = self.look_sent_at = None
        self.checks = 0


class Search:
    def __init__(self, enabled: bool = True, area: Optional[PlayArea] = None,
                 heading: bool = True):
        self.enabled = enabled
        self.heading = heading       # a moving player: where they were heading
        self.area = area or PlayArea.default()
        self._nodes: Dict[int, _Node] = {}
        self._votes = deque()        # (t_s, (gx, gy)), oldest first
        self._track: Optional[Track] = None

    # --- Where the player was -------------------------------------------------------

    def set_calibration(self, per_column: Sequence[tuple]) -> None:
        """calibration:update's (near, far) per column, for the cells' depths."""
        self.area = PlayArea.calibrated(per_column, self.area.width_cm)

    def set_track(self, track: Optional[Track]) -> None:
        """The game's position track (heading.track_from_event())."""
        self._track = track

    def reset(self) -> None:
        """A new round: nothing from the last one says where the player is."""
        self._votes.clear()
        self._track = None
        for node in self._nodes.values():
            node.ready()
            node.gave_up_at = node.gave_up_on = None

    def cell_of(self, role: str, distance_cm: float,
                angle_deg: float) -> Optional[Tuple[int, int]]:
        """The cell a node's reading puts the player in, or None off the board."""
        x, y = scanner_point(node_x_cm(role, self.area), body_centre_cm(distance_cm, _CONFIG),
                             angle_deg)
        if not self.area.contains_point(x, y):
            return None
        column = self.area.column_at(x)
        return column, self.area.row_for(column, y)

    def _vote(self, cell: Tuple[int, int], now_s: float) -> None:
        self._votes.append((now_s, cell))
        while self._votes and now_s - self._votes[0][0] > TARGET_MAX_AGE_S + WINDOW_S:
            self._votes.popleft()

    def target(self, now_s: float,
               since_s: Optional[float] = None) -> Optional[Tuple[Tuple[int, int], str]]:
        """The cell a lost node checks and how it was chosen: where a moving
        player was heading ("heading"), else the cell of target_cell()
        ("readings"); None with neither. since_s: only what was seen after
        then counts (the node gave up then)."""
        track = self._track
        if self.heading and (since_s is None or (track is not None and track.at_s > since_s)):
            cell = heading_target(track, now_s, self.area)
            if cell is not None:
                return cell, "heading"
        cell = self.target_cell(now_s, since_s)
        return None if cell is None else (cell, "readings")

    def target_cell(self, now_s: float,
                    since_s: Optional[float] = None) -> Optional[Tuple[int, int]]:
        """The cell the readings put a still player in: the one voted for most
        in the WINDOW_S up to the latest vote, ties to the latest, with at
        least MIN_VOTES; None with no vote in the last TARGET_MAX_AGE_S.
        since_s: only votes after then count."""
        votes = [(t, cell) for t, cell in self._votes if since_s is None or t > since_s]
        if not votes or now_s - votes[-1][0] > TARGET_MAX_AGE_S:
            return None
        latest = votes[-1][0]
        recent = [cell for t, cell in votes if t >= latest - WINDOW_S]
        counts = Counter(recent)
        best = max(counts.values())
        if best < MIN_VOTES:
            return None
        return next(cell for cell in reversed(recent) if counts[cell] == best)

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
               room: Optional[int] = None, far_hold: bool = True, held: bool = False,
               echo_cm: Optional[float] = None) -> Optional[SearchLook]:
        """One reading from a node; returns the LOOK to send, if any.

        state is the firmware's scan state (None from firmware that does not
        say: then an echo is found and no echo is lost). distance_cm is the
        distance it reported, which places its vote; echo_cm is the nearer of
        its two sensors' echoes, which the far hold goes by (app.py
        parse_nearest_echo_cm(); distance_cm when not given). far_hold is the
        Far hold switch, held is calibration holding the servos at 90.
        """
        node = self._nodes.setdefault(node_id, _Node())
        if echo_cm is None:
            echo_cm = distance_cm
        if state is None:
            state = LOST if distance_cm is None or distance_cm <= 0 else FOUND

        if state != LOST:
            node.last_echo_cm = echo_cm
            node.lost_streak = 0
            node.ready()
            if (not held and room != ROOM_LEARNING and SERVO_LIMITS.get(role) is not None
                    and angle_deg is not None and distance_cm is not None and distance_cm > 0):
                cell = self.cell_of(role, distance_cm, angle_deg)
                if cell is not None:
                    self._vote(cell, now_s)
            return None

        node.lost_streak += 1
        if (not self.enabled or held or room == ROOM_LEARNING
                or SERVO_LIMITS.get(role) is None or angle_deg is None):
            node.ready()
            return None

        if node.state == "ready":
            if self._far_holding(node, role, angle_deg, far_hold):
                return None
            target = self.target(now_s, node.gave_up_at)
            if target is None:
                # Nowhere to look yet: it sweeps, and its next lost reading
                # asks again (the other node may have found the player).
                return None
            node.state = "checking"
            node.cell, node.by = target
            node.target_deg = self.bearing_to(role, node.cell)
            node.started_at = now_s
            node.checks = 0

        if node.state != "checking":
            return None
        if now_s - node.started_at > SEARCH_TIMEOUT_S:
            node.give_up(now_s)
            return None
        at_cell = abs(angle_deg - node.target_deg) <= AT_CELL_DEG
        if at_cell:
            node.checks += 1
            if node.checks >= CHECK_READINGS:
                node.give_up(now_s)
                return None
        elif node.look_sent_at is not None and now_s - node.look_sent_at < LOOK_RETRY_S:
            # Read before the last LOOK took effect: it is on its way.
            return None
        node.look_sent_at = now_s
        node.last_echo_cm = None
        return SearchLook(node_id=node_id, degrees=node.target_deg, cell=node.cell,
                          checks=node.checks, by=node.by)

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
        or has given up on one and is sweeping."""
        node = self._nodes.get(node_id)
        if not self.enabled or node is None:
            return None
        if node.state == "checking":
            return {"state": "checking", "checks": node.checks, "of": CHECK_READINGS,
                    "cell": list(node.cell), "name": cell_name(node.cell), "by": node.by}
        if node.state == "sweeping" and node.gave_up_on is not None:
            return {"state": "sweeping", "cell": list(node.gave_up_on),
                    "name": cell_name(node.gave_up_on)}
        return None
