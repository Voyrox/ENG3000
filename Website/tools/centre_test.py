"""
centre_test.py - rig test for the centre column, where the player's x keeps
bouncing back.

Logs every scanner-node reading and the game's own position (the x and y the
cursor is drawn from, its cell, where each method - Dynamic, line of sight,
trilateration, average - puts the player, and which one Dynamic followed)
while someone stands on spots marked
on the floor. Then it reports, for each spot, where each node on its own puts
the player, how often each node was lost, whether the servo can turn far
enough to face the spot, and what was happening each time x left the column.

It listens on the phone control panel's feed (ws://<server>:8765/control) and
sends nothing. So the server must run with CON=1, and the game page must be
open on the game screen in sensor mode (Options -> Test mode keeps the round
from ending). No restart, no REC=1 and no change to the game are needed.

  marks    how far each spot is from each node's servo shaft, for taping
           the spots on the floor with one tape measure:

      .venv/Scripts/python.exe Website/tools/centre_test.py marks --spacing-cm 100

  run      walks you through the spots out loud, records, then reports:

      .venv/Scripts/python.exe Website/tools/centre_test.py run --spacing-cm 100

  report   reports on a run again (e.g. with the nodes named by hand):

      .venv/Scripts/python.exe Website/tools/centre_test.py report logs/centre-20261004-153000

The spots, in cm. x is across the play area as the game counts it (0 at its
left edge, the nodes at 25 and 125 when they are 100 cm apart); y is straight
out from the line through both nodes' servo shafts:

  empty         nobody in the play area (what the nodes see on their own)
  L-80, R-80    straight in front of the left / right node, 80 out (the columns
                that work: the comparison)
  C-40, C-80, C-120
                halfway between the nodes, 40 / 80 / 120 out
  walk-across   from in front of the left node to the right node and back, 80 out
  walk-centre   halfway between the nodes, from 40 out to 120 and back

A run writes logs/centre-<time>/: readings.csv (one row per node reading),
game.csv (the game's position, 10 a second), turns.csv (scan turn changes),
run.json (the spots, their times and the settings), report.md and a plot per
spot. The MAC the nodes send is never written: the repository is public.

Needs the websockets package (already in the server's requirements) and, for
the plots, matplotlib; without matplotlib the report is written without them.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import math
import os
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

# --- The game's geometry (game.js) and the nodes' (src/Config.h) --------------

PLAY_WIDTH_CM = 150.0
COLUMN_WIDTH_CM = PLAY_WIDTH_CM / 3
COLUMN_NAMES = ("left", "centre", "right")
# Where the game puts the nodes: the centres of the outer columns
# (columnCentreCm(0) and columnCentreCm(2)), whatever the real spacing is.
GAME_NODE_X = {"LEFT": 25.0, "RIGHT": 125.0}
GAME_SPACING_CM = GAME_NODE_X["RIGHT"] - GAME_NODE_X["LEFT"]
ROLES = ("LEFT", "RIGHT")
# The player is a body: a reading is to the side of them nearest the node, and
# the game adds this much to place their middle (game.js tuning.bodyRadiusCm).
BODY_RADIUS_CM = 15.0
# Servo travel per mount as (lowest, highest) angle: LEFT_NODE_LIMITS and
# RIGHT_NODE_LIMITS. 90 points straight out; the game takes larger angles as
# turning towards screen-right (see inward_limit() and the direction check).
SERVO_LIMITS = {"LEFT": (40.0, 160.0), "RIGHT": (30.0, 140.0)}
AT_LIMIT_DEG = 2.0          # an angle this close to the inward limit is "at the limit"
FOUND, HALF, LOST = 0, 1, 2
STATE_NAMES = {FOUND: "found", HALF: "half", LOST: "lost"}
METHODS = ("dyn", "los", "tri", "avg")

WS_PORT = 8765
DEFAULT_SERVER = "127.0.0.1"
DEFAULT_DEPTHS_CM = (40.0, 80.0, 120.0)
DEFAULT_STILL_S = 20.0
DEFAULT_WALK_S = 30.0
DEFAULT_SETTLE_S = 8.0
STATUS_STALE_S = 2.0        # no game:status for this long: the game page is gone
GAME_RATE_HZ = 10.0         # canvas.js sends game:status this often
RATE_WINDOW_S = 2.0
# Below this share of GAME_RATE_HZ the page is being throttled: Chrome slows
# the timers of a hidden, minimised or fully covered window and stops drawing
# it, and the game loop with it.
MIN_RATE_SHARE = 0.5

# The report's thresholds.
JUMP_CM = 15.0              # x moving this far between two game samples is a jump
MERGE_GAP_S = 0.3           # excursions closer together than this are one bounce
HANDOVER_MS = 400.0         # a bounce starting this soon after a turn began
DISAGREE_CM = 15.0          # the two nodes' x further apart than this
LOST_PCT = 30.0             # a node lost for more than this share of a spot
OFFSET_DEG = 4.0            # a servo angle further off than this
SPACING_TOLERANCE_CM = 5.0
FACING_DEG = 25.0           # a node this close to 90 at a control spot is the one in front
# The direction check: the two nodes must put a still player this much
# further apart the game's way than the other way before it says so.
REVERSED_MIN_GAP_CM = 40.0
REVERSED_RATIO = 0.4
CELL_LAG_S = 1.0            # the mole cell's vote trails x by up to this

READING_COLUMNS = ("t_s", "step", "phase", "node_id", "has_turn", "turn_ms",
                   "left_cm", "right_cm", "avg_cm", "angle_deg", "scan_state", "room")
GAME_COLUMNS = ("t_s", "step", "phase", "screen", "mode", "round", "method", "placed_by",
                "status", "held", "source", "x_cm", "y_cm", "gx", "gy", "board_nx", "board_ny",
                "dyn_x", "dyn_y", "los_x", "los_y", "tri_x", "tri_y", "avg_x", "avg_y")
TURN_COLUMNS = ("t_s", "step", "phase", "node_id", "has_turn")


# --- The spots -------------------------------------------------------------------

@dataclass(frozen=True)
class Step:
    name: str
    kind: str                   # "empty", "still" or "walk"
    spot: str                   # where to stand, as shown and said
    x_cm: Optional[float]       # where the player is in the game's frame, when known
    y_cm: Optional[float]

    @property
    def column(self):
        return None if self.x_cm is None else column_at(self.x_cm)


def plan_steps(spacing_cm=GAME_SPACING_CM, depths=DEFAULT_DEPTHS_CM):
    """Every spot, in the order they are run. The spots are laid out from the
    real nodes: halfway between them is the middle of the play area, and in
    front of a node is spacing/2 either side of it."""
    depths = sorted(float(d) for d in depths)
    middle = PLAY_WIDTH_CM / 2
    left_x, right_x = middle - spacing_cm / 2, middle + spacing_cm / 2
    side = depths[len(depths) // 2]
    steps = [
        Step("empty", "empty", "Nobody in the play area. Stand behind the line of the nodes.",
             None, None),
        Step(f"L-{side:g}", "still", f"Straight in front of the left node, {side:g} cm out.",
             left_x, side),
        Step(f"R-{side:g}", "still", f"Straight in front of the right node, {side:g} cm out.",
             right_x, side),
    ]
    for depth in depths:
        steps.append(Step(f"C-{depth:g}", "still", f"Halfway between the nodes, {depth:g} cm out.",
                          middle, depth))
    steps.append(Step("walk-across", "walk",
                      f"Start in front of the left node, {side:g} cm out. Walk slowly to the "
                      "right node and back, twice.", None, side))
    steps.append(Step("walk-centre", "walk",
                      f"Halfway between the nodes, {depths[0]:g} cm out. Walk slowly straight "
                      f"out to {depths[-1]:g} cm and back, twice.", middle, None))
    return steps


def column_at(x_cm):
    """game.js columnAtCm(): 0 left, 1 centre, 2 right, x clamped to the board."""
    return max(0, min(2, math.floor(x_cm / COLUMN_WIDTH_CM)))


def real_node_x(role, spacing_cm):
    """Where a node really is in the game's frame, with the nodes spacing_cm
    apart about the middle of the play area."""
    sign = -1 if role == "LEFT" else 1
    return PLAY_WIDTH_CM / 2 + sign * spacing_cm / 2


def expected_angle(role, spacing_cm, x_cm, y_cm, sign=1):
    """The servo angle that faces (x, y) from where the node really is. sign 1
    is the game's direction (larger turns towards screen-right), -1 the other."""
    return 90.0 + sign * math.degrees(math.atan2(x_cm - real_node_x(role, spacing_cm), y_cm))


def expected_distance(role, spacing_cm, x_cm, y_cm):
    return math.hypot(x_cm - real_node_x(role, spacing_cm), y_cm)


def own_point(role, distance_cm, angle_deg, sign=1, body_cm=BODY_RADIUS_CM):
    """Where one reading on its own puts the middle of the player: body_cm past
    the distance, along the servo angle, from where the game thinks the node
    is. sign 1 works it out as the game does (scannerPoint() in game.js:
    larger angles turn towards screen-right); -1 takes larger angles as
    turning towards screen-left."""
    phi = math.radians(angle_deg - 90.0)
    reach = distance_cm + body_cm
    return GAME_NODE_X[role] + sign * reach * math.sin(phi), reach * math.cos(phi)


def inward_limit(role, sign=1):
    """The servo limit a node reaches when it turns towards the centre."""
    low, high = SERVO_LIMITS[role]
    return (high if sign == 1 else low) if role == "LEFT" else (low if sign == 1 else high)


# --- Recording -------------------------------------------------------------------

def _cell(value, decimals=1):
    if value is None or value == "":
        return ""
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            return ""
        return round(value, decimals) if isinstance(value, float) else value
    return value


def _payload(latest):
    if isinstance(latest, dict):
        return latest
    try:
        payload = json.loads(latest) if latest else {}
    except (TypeError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _num(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


class RunLog:
    """The three CSV files of a run, filled from the control panel's feed."""

    def __init__(self, folder, clock=time.monotonic):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.clock = clock
        self.t0 = clock()
        self.step = ""
        self.phase = "setup"
        self._handles = []
        self._writers = {}
        for name, columns in (("readings", READING_COLUMNS), ("game", GAME_COLUMNS),
                              ("turns", TURN_COLUMNS)):
            handle = open(self.folder / f"{name}.csv", "w", newline="", encoding="utf-8")
            writer = csv.DictWriter(handle, fieldnames=columns)
            writer.writeheader()
            self._handles.append(handle)
            self._writers[name] = (writer, handle)
        self.last_seen = {}         # node id -> the server's stamp of its latest reading
        self.turn = {}              # node id -> holds the scan turn
        self.turn_since = {}        # node id -> when it was granted, s
        self.nodes = {}             # node id -> {"online", "angle", "room"} for the checks
        self.status = None          # the latest game:status from the game screen
        self.game_times = deque(maxlen=int(GAME_RATE_HZ * RATE_WINDOW_S * 3))
        self.other_screen = None    # another page's screen, and when it last said so
        self.other_at = None
        self.step_game = 0          # game-screen samples since the step or phase began
        self.counts = {"readings": 0, "game": 0, "turns": 0}

    def now(self):
        return self.clock() - self.t0

    def set_step(self, step, phase):
        self.step = step
        self.phase = phase
        self.step_game = 0

    def _write(self, name, row):
        writer, handle = self._writers[name]
        writer.writerow({key: _cell(value, 3 if key == "t_s" else 1) for key, value in row.items()})
        handle.flush()
        self.counts[name] += 1

    def on_message(self, event):
        kind = event.get("type")
        if kind == "nodes:update":
            self._on_nodes(event.get("nodes") or [])
        elif kind == "game:status":
            self._on_status(event)

    def _on_nodes(self, nodes):
        t = self.now()
        for node in nodes:
            node_id = node.get("id")
            if node_id is None:
                continue
            has_turn = bool(node.get("has_turn"))
            if self.turn.get(node_id) != has_turn:
                if has_turn:
                    self.turn_since[node_id] = t
                self._write("turns", {"t_s": t, "step": self.step, "phase": self.phase,
                                      "node_id": node_id, "has_turn": has_turn})
                self.turn[node_id] = has_turn
            payload = _payload(node.get("latest"))
            self.nodes[node_id] = {"online": bool(node.get("online")),
                                   "angle": _num(payload.get("angle")),
                                   "room": _num(payload.get("room"))}
            stamp = node.get("last_seen")
            if stamp is None or self.last_seen.get(node_id) == stamp:
                continue
            first = node_id not in self.last_seen
            self.last_seen[node_id] = stamp
            if first:
                continue    # already there when the log opened: not read during the run
            since = self.turn_since.get(node_id)
            self._write("readings", {
                "t_s": t, "step": self.step, "phase": self.phase, "node_id": node_id,
                "has_turn": has_turn,
                "turn_ms": (t - since) * 1000 if has_turn and since is not None else None,
                "left_cm": _num(payload.get("left")), "right_cm": _num(payload.get("right")),
                "avg_cm": _num(payload.get("avg")), "angle_deg": _num(payload.get("angle")),
                "scan_state": _num(payload.get("scanState", payload.get("state"))),
                "room": _num(payload.get("room")),
            })

    def _on_status(self, event):
        # Every connected game page sends one, so a second page left on the
        # menu interleaves its own: the game screen's are kept apart.
        t = self.now()
        if event.get("screen") == "game":
            self.status = event
            self.game_times.append(t)
            self.step_game += 1
        else:
            self.other_screen = event.get("screen")
            self.other_at = t
        cursor = event.get("cursor") or {}
        sensor = cursor.get("sensor") or {}
        board = cursor.get("board") or {}
        fixes = sensor.get("fixes") or {}
        row = {
            "t_s": t, "step": self.step, "phase": self.phase,
            "screen": event.get("screen"), "mode": event.get("mode"), "round": event.get("status"),
            "method": sensor.get("method") or event.get("positionMethod"),
            "placed_by": sensor.get("placedBy"),
            "status": sensor.get("status"),
            "held": sensor.get("held") if sensor else None,
            "source": sensor.get("source"),
            "x_cm": _num(sensor.get("xCm")), "y_cm": _num(sensor.get("yCm")),
            "gx": sensor.get("gx"), "gy": sensor.get("gy"),
            "board_nx": _num(board.get("nx")), "board_ny": _num(board.get("ny")),
        }
        for method in METHODS:
            fix = fixes.get(method) or {}
            row[f"{method}_x"] = _num(fix.get("xCm"))
            row[f"{method}_y"] = _num(fix.get("yCm"))
        for key in ("board_nx", "board_ny"):
            if row[key] is not None:
                row[key] = round(row[key], 4)
        self._write("game", row)

    def game_rate(self):
        """Game-screen updates a second over the last RATE_WINDOW_S."""
        now = self.now()
        return sum(1 for t in self.game_times if now - t <= RATE_WINDOW_S) / RATE_WINDOW_S

    def other_page(self):
        """The screen another game page is on, if one is still sending."""
        if self.other_at is not None and self.now() - self.other_at <= STATUS_STALE_S:
            return self.other_screen
        return None

    def problems(self):
        """What stops the run from starting; empty when it can."""
        found = []
        online = [node_id for node_id, node in self.nodes.items() if node["online"]]
        if len(online) < 2:
            found.append(f"{len(online)} node(s) online, need both")
        rate = self.game_rate()
        if rate == 0:
            other = self.other_page()
            found.append(f"the game page is on the '{other}' screen: start a round" if other else
                         "no game page on the game screen: open http://localhost:5000 and start "
                         "a round (if it is open, its window is minimised or covered)")
        elif rate < GAME_RATE_HZ * MIN_RATE_SHARE:
            found.append(f"the game page sends {rate:.1f} updates a second instead of "
                         f"{GAME_RATE_HZ:g}: Chrome slows a window that is minimised or covered. "
                         "Put the game and this terminal side by side (Win+Left, Win+Right)")
        elif self.status.get("mode") != "sensor":
            found.append("the game is following the phone pad: lift your finger off it")
        return found

    def notes(self):
        """Worth knowing but not stopping for."""
        other = self.other_page()
        if other and self.game_rate() > 0:
            return [f"a second game page is open on the '{other}' screen: close that tab"]
        return []

    def close(self):
        for handle in self._handles:
            handle.close()


# --- Prompts -----------------------------------------------------------------------

async def _in_thread(function, *args):
    """function(*args) on a daemon thread, so Ctrl+C never waits for it (a
    blocked input() would otherwise hold the program open)."""
    loop = asyncio.get_running_loop()
    future = loop.create_future()

    def finish(setter, value):
        if not future.done():
            setter(value)

    def work():
        try:
            value = function(*args)
        except BaseException as error:      # handed to the awaiting task
            loop.call_soon_threadsafe(finish, future.set_exception, error)
        else:
            loop.call_soon_threadsafe(finish, future.set_result, value)

    threading.Thread(target=work, daemon=True).start()
    return await future


async def say(text, voice):
    """Print a prompt and, on Windows with the voice on, speak it and wait
    until it has been said (System.Speech, through PowerShell)."""
    print(f"  >> {text}", flush=True)
    if not voice or os.name != "nt":
        return
    spoken = text.replace(" cm", " centimetres")
    script = ("Add-Type -AssemblyName System.Speech; "
              "(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($env:CENTRE_TEST_SAY)")
    try:
        process = subprocess.Popen(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                                   env=dict(os.environ, CENTRE_TEST_SAY=spoken),
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except OSError:
        return
    await _in_thread(process.wait, 30)


async def beep(pattern):
    """(frequency Hz, ms) pairs; silent where winsound is missing."""
    try:
        import winsound
    except ImportError:
        return
    for frequency, ms in pattern:
        await _in_thread(winsound.Beep, frequency, ms)


START_BEEP = ((880, 250),)
DONE_BEEP = ((660, 150), (440, 300))


# --- Running the test ------------------------------------------------------------

async def _receive(ws, log):
    async for message in ws:
        try:
            event = json.loads(message)
        except (TypeError, ValueError):
            continue
        if isinstance(event, dict):
            log.on_message(event)


def _write_run(folder, info):
    (Path(folder) / "run.json").write_text(json.dumps(info, indent=2), encoding="utf-8")


async def _wait_until_ready(log, receiver):
    shown = None
    await asyncio.sleep(RATE_WINDOW_S + 0.5)    # enough game:status to judge its rate
    while True:
        if receiver.done():
            raise ConnectionError("the server closed the control feed: start it with CON=1")
        problems = log.problems()
        if not problems:
            return
        text = "; ".join(problems)
        if text != shown:
            print(f"Waiting: {text}  (Ctrl+C to stop)", flush=True)
            shown = text
        await asyncio.sleep(0.5)


async def run_test(args):
    from websockets.asyncio.client import connect

    steps = plan_steps(args.spacing_cm, args.depths)
    if args.steps:
        names = {step.name for step in steps}
        unknown = [name for name in args.steps if name not in names]
        if unknown:
            print(f"Unknown step(s) {unknown}; the steps are {[s.name for s in steps]}")
            return 2
        steps = [step for step in steps if step.name in args.steps]

    folder = Path(args.out) / datetime.now().strftime("centre-%Y%m%d-%H%M%S")
    url = f"ws://{args.server}:{WS_PORT}/control"
    info = {
        "started": datetime.now().isoformat(timespec="seconds"),
        "spacing_cm": args.spacing_cm, "game_spacing_cm": GAME_SPACING_CM,
        "settle_s": args.settle, "still_s": args.seconds, "walk_s": args.walk_seconds,
        "left": args.left, "right": args.right,
        "steps": [], "method": None, "nodes": {},
    }
    log = RunLog(folder)
    args.run_folder = folder
    print(f"Logging to {folder}")
    try:
        async with connect(url, open_timeout=5, max_size=None) as ws:
            receiver = asyncio.create_task(_receive(ws, log))
            await _wait_until_ready(log, receiver)
            info["method"] = (log.status or {}).get("positionMethod")
            info["nodes"] = {str(node_id): {"angle": node["angle"], "room": node["room"]}
                             for node_id, node in log.nodes.items()}
            print(f"Ready: nodes {sorted(log.nodes)} online, method '{info['method']}', game "
                  f"page sending {log.game_rate():.0f} updates a second.")
            print("  Keep the game window visible for the whole run (side by side with this one):"
                  " a minimised or covered window is paused and its x is lost.")
            for note in log.notes():
                print(f"  note: {note}")
            for node_id, node in sorted(log.nodes.items()):
                if node["room"] is not None and node["room"] != 2:
                    print(f"  note: node {node_id} has not learnt the empty room (room={node['room']:g})")
            if abs(args.spacing_cm - GAME_SPACING_CM) >= SPACING_TOLERANCE_CM:
                print(f"  note: the nodes are {args.spacing_cm:g} cm apart; the game assumes "
                      f"{GAME_SPACING_CM:g}. Spots are laid out from the real nodes.")
            _write_run(folder, info)

            for index, step in enumerate(steps, 1):
                seconds = args.walk_seconds if step.kind == "walk" else args.seconds
                print(f"\n[{index}/{len(steps)}] {step.name}: {step.spot}  ({seconds:g} s)")
                if not args.auto:
                    try:
                        answer = await _in_thread(input, "    Enter = go, s = skip, q = stop and report: ")
                    except EOFError:
                        answer = "q"
                    answer = answer.strip().lower()
                    if answer == "q":
                        break
                    if answer == "s":
                        continue
                if receiver.done():
                    raise ConnectionError("the control feed closed")
                log.set_step(step.name, "settle")
                cue = (" Start moving at the beep." if step.kind == "walk"
                       else " Stand still, facing the screen." if step.kind == "still" else "")
                await say(f"Step {index} of {len(steps)}. {step.spot}{cue}", args.voice)
                await asyncio.sleep(args.settle)
                for problem in log.problems():
                    print(f"  warning: {problem}")
                await beep(START_BEEP)
                log.set_step(step.name, "record")
                start = log.now()
                print(f"    recording {seconds:g} s ...", flush=True)
                await asyncio.sleep(seconds)
                end = log.now()
                samples = log.step_game
                log.set_step("", "between")
                await beep(DONE_BEEP)
                info["steps"].append({**asdict(step), "start_s": round(start, 3),
                                      "end_s": round(end, 3)})
                _write_run(folder, info)
                if samples < GAME_RATE_HZ * MIN_RATE_SHARE * (end - start):
                    print(f"  warning: only {samples} game samples in {end - start:.0f} s: the "
                          "game window was minimised or covered, so this step has no cursor x. "
                          f"Redo it afterwards with --steps {step.name}")
                    await say("Warning: the game window is hidden. Its position was not recorded.",
                              args.voice)
            await say("Done. Thank you.", args.voice)
            receiver.cancel()
    except (OSError, ConnectionError) as error:
        print(f"Could not log from {url}: {error}")
        print("Is the server running with CON=1 (set CON=1 before python app.py)?")
        return 1
    finally:
        log.close()
        _write_run(folder, info)

    print(f"\n{log.counts['readings']} readings and {log.counts['game']} game samples logged.")
    if not info["steps"]:
        print("No step was recorded.")
        return 1
    return report(folder, left=args.left, right=args.right, plots=not args.no_plots)


# --- Reading a run back ----------------------------------------------------------

@dataclass(frozen=True)
class Reading:
    t: float
    step: str
    phase: str
    node: int
    has_turn: bool
    turn_ms: Optional[float]
    left: Optional[float]
    right: Optional[float]
    avg: Optional[float]
    angle: Optional[float]
    state: Optional[int]

    @property
    def usable(self):
        """What the line-of-sight track takes: an echo, an angle, not lost."""
        return (self.avg is not None and self.avg >= 0 and self.angle is not None
                and self.state != LOST)


@dataclass(frozen=True)
class GameRow:
    t: float
    step: str
    phase: str
    screen: str
    mode: str
    method: str
    status: str
    held: bool
    source: str
    x: Optional[float]
    y: Optional[float]
    gx: Optional[int]
    gy: Optional[int]
    fixes: dict
    # The method the position came from: the one switched on, or the one
    # Dynamic followed. None in a run from before Dynamic.
    placed_by: Optional[str] = None


@dataclass
class Run:
    folder: Path
    info: dict
    steps: list
    readings: list
    game: list
    turns: list         # (t, node id, has_turn)


def _int(text):
    value = _num(text)
    return None if value is None else int(value)


def _rows(path):
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def load_run(folder):
    folder = Path(folder)
    info = json.loads((folder / "run.json").read_text(encoding="utf-8"))
    steps = [(Step(s["name"], s["kind"], s["spot"], s["x_cm"], s["y_cm"]), s["start_s"], s["end_s"])
             for s in info.get("steps", [])]
    readings = [Reading(
        t=_num(r["t_s"]) or 0.0, step=r["step"], phase=r["phase"], node=_int(r["node_id"]),
        has_turn=r["has_turn"] == "1", turn_ms=_num(r["turn_ms"]),
        left=_num(r["left_cm"]), right=_num(r["right_cm"]), avg=_num(r["avg_cm"]),
        angle=_num(r["angle_deg"]), state=_int(r["scan_state"]),
    ) for r in _rows(folder / "readings.csv")]
    game = [GameRow(
        t=_num(r["t_s"]) or 0.0, step=r["step"], phase=r["phase"], screen=r["screen"],
        mode=r["mode"], method=r["method"], status=r["status"], held=r["held"] == "1",
        source=r["source"], x=_num(r["x_cm"]), y=_num(r["y_cm"]), gx=_int(r["gx"]), gy=_int(r["gy"]),
        # A run from before Dynamic has no dyn_x, dyn_y or placed_by.
        fixes={m: (_num(r.get(f"{m}_x")), _num(r.get(f"{m}_y"))) for m in METHODS},
        placed_by=r.get("placed_by") or None,
    ) for r in _rows(folder / "game.csv")]
    turns = [(_num(r["t_s"]) or 0.0, _int(r["node_id"]), r["has_turn"] == "1")
             for r in _rows(folder / "turns.csv")]
    return Run(folder, info, steps, readings, game, turns)


# --- Statistics --------------------------------------------------------------------

def quantile(values, q):
    """Linear interpolation between the closest ranks; None when empty."""
    ordered = sorted(values)
    if not ordered:
        return None
    position = (len(ordered) - 1) * q
    low = math.floor(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def median(values):
    return quantile(values, 0.5)


def pct(part, whole):
    return None if whole == 0 else 100.0 * part / whole


def infer_roles(run, left=None, right=None):
    """Which node id is LEFT and which RIGHT, and how that was decided.

    By hand (--left/--right) first. Otherwise from the two control spots: the
    node that faces a spot straight on (servo near 90) is the node in front of
    it. Failing that, from the servo travel: only the LEFT mount turns past
    140 and only the RIGHT one below 40."""
    roles = {}
    if left is not None:
        roles[left] = "LEFT"
    if right is not None:
        roles[right] = "RIGHT"
    how = "given by hand" if roles else None
    node_ids = sorted({r.node for r in run.readings if r.node is not None})

    if len(roles) < 2:
        votes = {}
        for step, start, end in run.steps:
            if step.kind != "still" or step.name[:2] not in ("L-", "R-"):
                continue
            role = "LEFT" if step.name.startswith("L-") else "RIGHT"
            angles = {}
            for r in _in_step(run.readings, step.name):
                if r.usable:
                    angles.setdefault(r.node, []).append(r.angle)
            facing = sorted((abs(median(a) - 90), node) for node, a in angles.items() if len(a) >= 3)
            # Only a node that really faces the spot: if the node in front saw
            # nothing, the other one is not it.
            if facing and facing[0][0] <= FACING_DEG:
                votes.setdefault(facing[0][1], set()).add(role)
        for node, said in votes.items():
            if len(said) == 1 and node not in roles and next(iter(said)) not in roles.values():
                roles[node] = next(iter(said))
        if roles and how is None:
            how = "the node facing each control spot straight on"

    if len(roles) < 2:
        for node in node_ids:
            if node in roles:
                continue
            angles = [r.angle for r in run.readings if r.node == node and r.angle is not None]
            if angles and max(angles) > SERVO_LIMITS["RIGHT"][1] + 1 and "LEFT" not in roles.values():
                roles[node] = "LEFT"
            elif angles and min(angles) < SERVO_LIMITS["LEFT"][0] - 1 and "RIGHT" not in roles.values():
                roles[node] = "RIGHT"
        if roles and how is None:
            how = "the servo travel (only LEFT turns past 140, only RIGHT below 40)"

    if len(roles) == 1 and len(node_ids) == 2:
        other = next(n for n in node_ids if n not in roles)
        roles[other] = "RIGHT" if "LEFT" in roles.values() else "LEFT"
    return roles, how


def _in_step(rows, name):
    return [row for row in rows if row.step == name and row.phase == "record"]


@dataclass
class NodeStats:
    role: str
    node: int
    n: int
    found_pct: Optional[float]
    half_pct: Optional[float]
    lost_pct: Optional[float]
    no_echo_pct: Optional[float]
    at_limit_pct: Optional[float]
    angle_med: Optional[float]
    angle_expected: Optional[float]
    reachable: Optional[bool]
    dist_med: Optional[float]
    dist_expected: Optional[float]
    x_med: Optional[float]
    x_p10: Optional[float]
    x_p90: Optional[float]
    y_med: Optional[float]
    in_column_pct: Optional[float]
    usable: int


def node_stats(readings, role, node, step, spacing_cm, sign=1):
    """One node at one spot, with the angles taken in direction sign (see
    own_point())."""
    rows = [r for r in readings if r.node == node]
    n = len(rows)
    usable = [r for r in rows if r.usable]
    states = [r.state for r in rows]
    points = [own_point(role, r.avg, r.angle, sign) for r in usable]
    xs = [p[0] for p in points]
    inward = inward_limit(role, sign)
    angle_expected = dist_expected = reachable = None
    if step.x_cm is not None and step.y_cm is not None:
        angle_expected = expected_angle(role, spacing_cm, step.x_cm, step.y_cm, sign)
        dist_expected = expected_distance(role, spacing_cm, step.x_cm, step.y_cm)
        low, high = SERVO_LIMITS[role]
        reachable = low <= angle_expected <= high
    column = step.column
    return NodeStats(
        role=role, node=node, n=n,
        found_pct=pct(states.count(FOUND), n), half_pct=pct(states.count(HALF), n),
        lost_pct=pct(states.count(LOST), n),
        no_echo_pct=pct(sum(1 for r in rows if r.avg is None or r.avg < 0), n),
        at_limit_pct=pct(sum(1 for r in rows if r.angle is not None
                             and abs(r.angle - inward) <= AT_LIMIT_DEG), n),
        angle_med=median([r.angle for r in usable]), angle_expected=angle_expected,
        reachable=reachable,
        dist_med=median([r.avg for r in usable]), dist_expected=dist_expected,
        x_med=median(xs), x_p10=quantile(xs, 0.1), x_p90=quantile(xs, 0.9),
        y_med=median([p[1] for p in points]),
        in_column_pct=None if column is None else pct(sum(1 for x in xs if column_at(x) == column),
                                                       len(xs)),
        usable=len(usable),
    )


@dataclass
class Bounce:
    start: float                # s from the start of the spot's recording
    duration: float
    side: str                   # the column x went to
    peak_x: float
    cell_moved: bool            # the game's cell (the mole that gets hit) moved too
    turn_role: Optional[str]    # who held the scan turn when it started
    turn_ms: Optional[float]    # how long they had held it
    before: Optional[str]       # the last node reading before it started


def turn_holder(turns, t):
    """(node id, s since it was granted) for the node holding the turn at t."""
    latest = {}
    for when, node, has_turn in turns:
        if when > t:
            break
        latest[node] = (when, has_turn)
    holding = [(when, node) for node, (when, has_turn) in latest.items() if has_turn]
    if not holding:
        return None, None
    when, node = max(holding)
    return node, t - when


def turn_segments(turns, start, end):
    """(from, to, node id or None) for who held the turn between start and end."""
    times = [start] + [when for when, _, _ in turns if start < when < end] + [end]
    return [(a, b, turn_holder(turns, a)[0]) for a, b in zip(times, times[1:]) if b > a]


def describe_reading(reading, roles):
    if reading is None:
        return None
    role = roles.get(reading.node, f"node{reading.node}")
    state = STATE_NAMES.get(reading.state, "?")
    if reading.avg is None or reading.avg < 0:
        return f"{role} {state}, no echo, {reading.angle:g} deg" if reading.angle is not None \
            else f"{role} {state}, no echo"
    text = f"{role} {state} {reading.angle:g} deg {reading.avg:.0f} cm"
    if reading.usable and role in GAME_NODE_X:
        text += f" -> game's x {own_point(role, reading.avg, reading.angle)[0]:.0f}"
    return text


def find_bounces(game_rows, column, start_s, readings, turns, roles):
    """Every time x left the spot's column: a run of samples in one other
    column, with returns shorter than MERGE_GAP_S bridged. game_rows are the
    samples the cursor was drawn from, in time order."""
    rows = [g for g in game_rows if g.x is not None]
    spans = []
    current = None
    for g in rows:
        out = column_at(g.x) != column
        if (out and current is not None and g.t - current[-1].t <= MERGE_GAP_S
                and column_at(g.x) == column_at(current[-1].x)):
            current.append(g)
        elif out:
            current = [g]
            spans.append(current)
        elif current is not None and g.t - current[-1].t > MERGE_GAP_S:
            current = None
    period = _sample_period(rows)
    bounces = []
    for outside in spans:
        first, last = outside[0], outside[-1]
        peak = max(outside, key=lambda g: abs(g.x - (column + 0.5) * COLUMN_WIDTH_CM))
        node, held_for = turn_holder(turns, first.t)
        before = None
        for reading in readings:
            if reading.t > first.t:
                break
            before = reading
        bounces.append(Bounce(
            start=first.t - start_s, duration=last.t - first.t + period,
            side=COLUMN_NAMES[column_at(peak.x)], peak_x=peak.x,
            cell_moved=any(g.gx is not None and g.gx != column for g in rows
                           if first.t <= g.t <= last.t + CELL_LAG_S),
            turn_role=roles.get(node, None if node is None else f"node{node}"),
            turn_ms=None if held_for is None else held_for * 1000,
            before=describe_reading(before, roles),
        ))
    return bounces


def _sample_period(rows):
    gaps = [b.t - a.t for a, b in zip(rows, rows[1:]) if b.t > a.t]
    return median(gaps) or 0.1


@dataclass
class GameStats:
    n: int
    sensor_n: int
    ok_pct: Optional[float]
    held_pct: Optional[float]
    statuses: dict
    x_med: Optional[float]
    x_p10: Optional[float]
    x_p90: Optional[float]
    x_min: Optional[float]
    x_max: Optional[float]
    y_med: Optional[float]
    in_column_pct: Optional[float]
    cell_in_column_pct: Optional[float]
    cell_changes: int
    jumps: int
    methods: dict               # method -> (x median, % in the column, samples)
    method_used: Optional[str]
    expected_n: int = 0         # samples a visible game page sends in the time
    bounces: list = field(default_factory=list)
    followed: dict = field(default_factory=dict)   # with Dynamic on: method -> % of samples

    @property
    def covered(self):
        """Whether the game page sent enough to judge its x (it was visible)."""
        return self.expected_n > 0 and self.sensor_n >= MIN_RATE_SHARE * self.expected_n


def game_stats(rows, step, start_s, readings, turns, roles, seconds=0.0):
    sensor = [g for g in rows if g.screen == "game" and g.mode == "sensor" and g.status]
    # The samples the cursor is drawn from: "ok", held or not. (Out of bounds
    # and no signal carry an x too, but no cursor is drawn.)
    with_x = [g for g in sensor if g.x is not None and g.status == "ok"]
    xs = [g.x for g in with_x]
    statuses = {}
    for g in sensor:
        key = "held" if g.held else g.status
        statuses[key] = statuses.get(key, 0) + 1
    column = step.column
    cells = [g.gx for g in sensor if g.gx is not None]
    methods = {}
    for method in METHODS:
        mx = [g.fixes[method][0] for g in sensor if g.fixes[method][0] is not None]
        methods[method] = (median(mx),
                           None if column is None else pct(sum(1 for x in mx if column_at(x) == column),
                                                           len(mx)),
                           len(mx))
    used = [g.method for g in sensor if g.method]
    dynamic = [g.placed_by for g in sensor if g.method == "dyn" and g.placed_by]
    followed = {m: pct(dynamic.count(m), len(dynamic)) for m in sorted(set(dynamic), key=dynamic.count,
                                                                       reverse=True)}
    return GameStats(
        n=len(rows), sensor_n=len(sensor),
        ok_pct=pct(sum(1 for g in sensor if g.status == "ok" and not g.held), len(sensor)),
        held_pct=pct(sum(1 for g in sensor if g.held), len(sensor)),
        statuses=statuses,
        x_med=median(xs), x_p10=quantile(xs, 0.1), x_p90=quantile(xs, 0.9),
        x_min=min(xs) if xs else None, x_max=max(xs) if xs else None,
        y_med=median([g.y for g in with_x if g.y is not None]),
        in_column_pct=None if column is None else pct(sum(1 for x in xs if column_at(x) == column),
                                                       len(xs)),
        cell_in_column_pct=None if column is None else pct(cells.count(column), len(cells)),
        cell_changes=sum(1 for a, b in zip(cells, cells[1:]) if a != b),
        jumps=sum(1 for a, b in zip(with_x, with_x[1:])
                  if b.t - a.t <= 0.25 and abs(b.x - a.x) >= JUMP_CM),
        methods=methods,
        method_used=max(set(used), key=used.count) if used else None,
        expected_n=int(seconds * GAME_RATE_HZ),
        bounces=[] if column is None else find_bounces(with_x, column, start_s, readings, turns, roles),
        followed=followed,
    )


def direction_check(run, roles):
    """[(spot, gap the game's way, gap the other way)] for every still spot
    both nodes saw: how far apart the two nodes put the player, in cm, taking
    larger servo angles as turning towards screen-right (as the game does) and
    towards screen-left. Two nodes looking at one still player should agree;
    this needs no tape measure, only that both saw you."""
    by_role = {role: node for node, role in roles.items()}
    rows = []
    if len(by_role) < 2:
        return rows
    for step, start, end in run.steps:
        if step.kind != "still":
            continue
        readings = [r for r in _in_step(run.readings, step.name) if r.usable]
        gaps = []
        for sign in (1, -1):
            points = {}
            for role in ROLES:
                pts = [own_point(role, r.avg, r.angle, sign) for r in readings if r.node == by_role[role]]
                if len(pts) >= 5:
                    points[role] = (median([p[0] for p in pts]), median([p[1] for p in pts]))
            gaps.append(math.dist(points["LEFT"], points["RIGHT"]) if len(points) == 2 else None)
        if None not in gaps:
            rows.append((step.name, gaps[0], gaps[1]))
    return rows


def angle_sign(check):
    """-1 when the nodes agree far better with the angles turned the other way."""
    if len(check) < 2:
        return 1
    game = median([g for _, g, _ in check])
    other = median([o for _, _, o in check])
    return -1 if game >= REVERSED_MIN_GAP_CM and other <= REVERSED_RATIO * game else 1


def analyse(run, left=None, right=None):
    roles, how = infer_roles(run, left, right)
    by_role = {role: node for node, role in roles.items()}
    spacing = float(run.info.get("spacing_cm") or GAME_SPACING_CM)
    check = direction_check(run, roles)
    sign = angle_sign(check)
    results = []
    for step, start, end in run.steps:
        readings = _in_step(run.readings, step.name)
        nodes = {role: node_stats(readings, role, by_role[role], step, spacing, sign)
                 for role in ROLES if role in by_role}
        game = game_stats(_in_step(run.game, step.name), step, start, run.readings, run.turns, roles,
                          seconds=end - start)
        results.append({"step": step, "start": start, "end": end, "nodes": nodes, "game": game})
    return {"roles": roles, "how": how, "spacing": spacing, "steps": results, "sign": sign,
            "direction": check, "findings": findings(results, spacing, roles, sign, check)}


# --- What it points to ---------------------------------------------------------------

def _f(value, decimals=0, unit=""):
    return "-" if value is None else f"{value:.{decimals}f}{unit}"


def findings(results, spacing, roles, sign=1, check=()):
    out = []
    if len(roles) < 2:
        out.append("Could not tell which node is LEFT and which RIGHT, so the per-node numbers "
                   "are missing: run `report` again with --left <id> --right <id>.")
    if sign == -1:
        game = median([g for _, g, _ in check])
        other = median([o for _, _, o in check])
        out.append(f"**The servo angles turn the other way from what the game assumes.** Taking a "
                   f"larger angle as turning towards screen-LEFT, the two nodes agree on where you "
                   f"stood (median {other:.0f} cm apart over {len(check)} still spots); the way the "
                   f"game takes them (towards screen-right) they are {game:.0f} cm apart. Straight in "
                   "front of a node the angle is near 90, where the direction hardly matters - which "
                   "is why the side columns work. In the centre each node turns 30-50 deg, so each "
                   "puts you on the far side of the board from where you are, and x crosses the board "
                   "every time the scan turn passes to the other node. The per-node numbers below use "
                   "the direction that fits.")
    if abs(spacing - GAME_SPACING_CM) >= SPACING_TOLERANCE_CM:
        out.append(f"The nodes are {spacing:g} cm apart but the game places them "
                   f"{GAME_SPACING_CM:g} cm apart (x = 25 and 125). In the centre each node "
                   f"then puts you about {abs(spacing - GAME_SPACING_CM) / 2:.0f} cm off, in "
                   "opposite directions, and x swaps between the two at every scan turn.")

    centre = [r for r in results if r["step"].kind == "still" and r["step"].name.startswith("C-")]
    controls = [r for r in results if r["step"].kind == "still" and r["step"].name[:2] in ("L-", "R-")]

    hidden = [r for r in results if r["game"].expected_n and not r["game"].covered]
    if hidden:
        out.append("The game page sent too little to judge the game's own x at "
                   + ", ".join(f"{r['step'].name} ({r['game'].sensor_n} of ~{r['game'].expected_n})"
                               for r in hidden)
                   + ": its window was minimised or covered (Chrome pauses it), or it was not on "
                   "the game screen. The node numbers are unaffected. Redo those steps with the game "
                   "window visible to see the cursor's x.")

    short = [stats.dist_expected - stats.dist_med
             for r in controls + centre for stats in r["nodes"].values()
             if stats.dist_med is not None and stats.dist_expected is not None and stats.usable >= 5]
    if len(short) >= 2:
        gap = median(short)
        verdict = ("about what the game adds back" if abs(gap - BODY_RADIUS_CM) < 5 else
                   "so the game's tuning.bodyRadiusCm wants to be nearer that, or the spots were "
                   "measured from somewhere other than the servo shafts")
        out.append(f"The readings fell a median {gap:.0f} cm short of the taped spots "
                   f"({min(short):.0f} to {max(short):.0f} cm over {len(short)} node-spots): they "
                   f"come off the side of you nearest the node. The game adds {BODY_RADIUS_CM:g} cm "
                   f"for that; {gap:.0f} cm is {verdict}.")

    for r in controls:
        role = "LEFT" if r["step"].name.startswith("L-") else "RIGHT"
        stats = r["nodes"].get(role)
        if stats and stats.angle_med is not None and stats.usable >= 5:
            offset = stats.angle_med - stats.angle_expected
            if abs(offset) >= OFFSET_DEG:
                aside = (stats.dist_med or 0) * math.sin(math.radians(abs(offset)))
                out.append(f"At {r['step'].name} the {role} node faced {stats.angle_med:.0f} deg, "
                           f"{abs(offset):.0f} deg off straight out, while you stood in front of it: "
                           f"either its servo's 90 is that far off, or you stood about {aside:.0f} cm "
                           "to the side of it.")

    for r in centre:
        name = r["step"].name
        left, right = r["nodes"].get("LEFT"), r["nodes"].get("RIGHT")
        for stats in (left, right):
            if stats is None:
                continue
            if stats.reachable is False:
                out.append(f"At {name} the {stats.role} node would have to turn to "
                           f"{stats.angle_expected:.0f} deg to face you, past its "
                           f"{inward_limit(stats.role, sign):.0f} deg limit (src/Config.h); "
                           f"{_f(stats.at_limit_pct)}% of its readings were at the limit.")
            if stats.lost_pct is not None and stats.lost_pct >= LOST_PCT:
                out.append(f"At {name} the {stats.role} node was lost (sweeping) for "
                           f"{stats.lost_pct:.0f}% of its readings; those place nobody, so the "
                           "other node alone moves x for that part of each turn.")
        if left and right and left.x_med is not None and right.x_med is not None:
            gap = left.x_med - right.x_med
            if abs(gap) >= DISAGREE_CM:
                implied = GAME_SPACING_CM + gap
                cause = (f"the nodes being {implied:.0f} cm apart instead of {spacing:g}, a servo "
                         "angle being off, or where you stood" if 0 < implied < 300
                         else "a servo angle being off, or where you stood")
                out.append(f"At {name} the two nodes disagree: on its own the LEFT node puts you at "
                           f"x = {left.x_med:.0f} and the RIGHT node at x = {right.x_med:.0f} (the "
                           f"spot is at {r['step'].x_cm:.0f}). The line-of-sight track leans towards "
                           f"whichever node has the turn, so x can move up to {abs(gap):.0f} cm at "
                           f"each handover. That fits {cause}.")

    bounces = [b for r in centre for b in r["game"].bounces]
    covered = [r for r in centre if r["game"].covered]
    if not covered and centre:
        out.append("No usable game samples in the centre spots, so the game's own x there could "
                   "not be checked (see above).")
    elif bounces:
        total_s = sum(r["end"] - r["start"] for r in centre)
        early = sum(1 for b in bounces if b.turn_ms is not None and b.turn_ms <= HANDOVER_MS)
        by_role = {}
        for b in bounces:
            by_role[b.turn_role or "nobody"] = by_role.get(b.turn_role or "nobody", 0) + 1
        sides = {}
        for b in bounces:
            sides[b.side] = sides.get(b.side, 0) + 1
        moved = sum(1 for b in bounces if b.cell_moved)
        out.append(f"In the centre spots x left the centre column {len(bounces)} times in "
                   f"{total_s:.0f} s ({60 * len(bounces) / total_s:.1f} a minute); the mole cell "
                   f"moved with it {moved} times. {early} of them started within "
                   f"{HANDOVER_MS:.0f} ms of a node taking its turn. Turn holder when they started: "
                   + ", ".join(f"{k} {v}" for k, v in sorted(by_role.items()))
                   + "; went to: " + ", ".join(f"{k} {v}" for k, v in sorted(sides.items())) + ".")
    elif centre:
        out.append("x never left the centre column during the centre spots the game page "
                   "covered.")

    if covered:
        scores = {}
        for method in METHODS:
            values = [(r["game"].methods[method][1], r["game"].methods[method][2]) for r in centre]
            n = sum(count for _, count in values)
            if n:
                scores[method] = sum((p or 0) * count for p, count in values) / n
        used = next((r["game"].method_used for r in centre if r["game"].method_used), None)
        if scores:
            best = max(scores, key=scores.get)
            text = ", ".join(f"{m} {scores[m]:.0f}%" for m in METHODS if m in scores)
            out.append(f"x inside the centre column, by method, over the centre spots: {text} "
                       f"(the game used '{used}')."
                       + (f" '{best}' did best." if used and best != used else ""))

    for r in controls:
        g = r["game"]
        if g.in_column_pct is not None and g.covered:
            out.append(f"Control {r['step'].name}: x in its own column {g.in_column_pct:.0f}% of "
                       f"the time, {len(g.bounces)} excursions.")

    for r in results:
        if r["step"].kind == "empty":
            g = r["game"]
            ok = g.statuses.get("ok", 0) + g.statuses.get("held", 0)
            if g.sensor_n and ok:
                out.append(f"With nobody there the game still placed a player {pct(ok, g.sensor_n):.0f}% "
                           f"of the time (x median {_f(g.x_med)}): furniture or floor echoes that "
                           "also pull x around while someone plays.")
    return out


# --- The report ------------------------------------------------------------------------

def _table(headers, rows):
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    lines += ["| " + " | ".join(str(cell) for cell in row) + " |" for row in rows]
    return "\n".join(lines)


def format_report(run, result):
    roles = result["roles"]
    lines = [f"# Centre column test, {run.info.get('started', '')}", ""]
    lines.append(f"- Run folder: `{run.folder}`")
    lines.append(f"- Method the game used: {run.info.get('method')}")
    lines.append(f"- Nodes measured {result['spacing']:g} cm apart (the game assumes "
                 f"{GAME_SPACING_CM:g})")
    named = ", ".join(f"node {node} = {role}" for node, role in sorted(roles.items())) or "unknown"
    lines.append(f"- {named}" + (f" ({result['how']})" if result["how"] else ""))
    lines += ["", "## Findings", ""]
    lines += [f"- {text}" for text in result["findings"]] or ["- none"]

    if result["direction"]:
        lines += ["", "## Angle direction check", "",
                  "How far apart the two nodes put you at each still spot (cm), with larger servo "
                  "angles turning towards screen-right (what the game assumes) and towards "
                  "screen-left. The direction that is right makes them agree.", ""]
        lines.append(_table(["spot", "game's direction", "other direction"],
                            [[name, f"{game:.0f}", f"{other:.0f}"]
                             for name, game, other in result["direction"]]))

    lines += ["", "## The game's x per spot", "",
              "x is what the cursor is drawn from; cell is the mole cell the game hits. "
              "\"in col\" is the share of samples in the spot's own column. \"samples\" should be "
              f"about {GAME_RATE_HZ:g} a second; far fewer means the game window was hidden.", ""]
    rows = []
    for r in result["steps"]:
        g, step = r["game"], r["step"]
        rows.append([step.name, _f(step.x_cm), _f(step.y_cm), f"{g.sensor_n}/{g.expected_n}",
                     _f(g.ok_pct), _f(g.held_pct),
                     _f(g.x_med), f"{_f(g.x_p10)}..{_f(g.x_p90)}", f"{_f(g.x_min)}..{_f(g.x_max)}",
                     _f(g.y_med), _f(g.in_column_pct), _f(g.cell_in_column_pct), g.cell_changes,
                     g.jumps, len(g.bounces)])
    lines.append(_table(["spot", "true x", "true y", "samples", "ok %", "held %", "x med", "x p10..p90",
                         "x min..max", "y med", "x in col %", "cell in col %", "cell changes",
                         f"jumps >={JUMP_CM:g}", "bounces"], rows))

    direction = ("the game's (larger angles turn towards screen-right)" if result["sign"] == 1
                 else "the other way from the game (larger angles turn towards screen-left), "
                      "which is what fits this run; \"angle needed\" is in that direction too")
    lines += ["", "## Each node on its own", "",
              "Where one reading alone puts the middle of the player (its distance plus "
              f"{BODY_RADIUS_CM:g} cm for the body, along its servo angle, from where the game "
              "thinks the node is), over the readings the line-of-sight track uses (an echo and "
              f"not lost). Angle direction: {direction}. \"dist med\" is the reading itself, to "
              "the near side of you; \"dist true\" is to the spot. \"limit %\" is readings "
              f"within {AT_LIMIT_DEG:g} deg of the servo's inward limit.", ""]
    rows = []
    for r in result["steps"]:
        for role in ROLES:
            s = r["nodes"].get(role)
            if s is None:
                continue
            reach = "" if s.reachable is None else ("yes" if s.reachable else "NO")
            rows.append([r["step"].name, f"{role} ({s.node})", s.n, _f(s.found_pct), _f(s.half_pct),
                         _f(s.lost_pct), _f(s.no_echo_pct), _f(s.angle_med), _f(s.angle_expected),
                         reach, _f(s.at_limit_pct), _f(s.dist_med), _f(s.dist_expected), _f(s.x_med),
                         f"{_f(s.x_p10)}..{_f(s.x_p90)}", _f(s.y_med), _f(s.in_column_pct)])
    lines.append(_table(["spot", "node", "readings", "found %", "half %", "lost %", "no echo %",
                         "angle med", "angle needed", "reachable", "limit %", "dist med",
                         "dist true", "x med", "x p10..p90", "y med", "x in col %"], rows))

    lines += ["", "## Each method", "", "x median and share in the spot's column, per method,",
              "and which method Dynamic followed (with Dynamic on).", ""]
    rows = []
    for r in result["steps"]:
        g = r["game"]
        follows = ", ".join(f"{m} {p:.0f}%" for m, p in g.followed.items()) or "--"
        rows.append([r["step"].name] + [f"{_f(g.methods[m][0])} / {_f(g.methods[m][1])}%"
                                        for m in METHODS] + [follows])
    lines.append(_table(["spot"] + list(METHODS) + ["dyn follows"], rows))

    for r in result["steps"]:
        bounces = r["game"].bounces
        if not bounces:
            continue
        lines += ["", f"## Bounces at {r['step'].name}", ""]
        rows = [[f"{b.start:.1f}", f"{b.duration:.1f}", b.side, f"{b.peak_x:.0f}",
                 "yes" if b.cell_moved else "", b.turn_role or "-", _f(b.turn_ms),
                 b.before or "-"] for b in bounces[:40]]
        lines.append(_table(["at s", "for s", "went to", "peak x", "cell moved", "turn holder",
                             "ms into turn", "last reading before"], rows))
        if len(bounces) > 40:
            lines.append(f"\n... and {len(bounces) - 40} more.")

    lines += ["", "## Files", "",
              "readings.csv (every node reading), game.csv (the game, 10 a second), turns.csv, "
              "run.json, and plot-<spot>.png: x over time with each node's own x and the scan "
              "turns shaded, and the servo angles against the angle that faces the spot.", ""]
    return "\n".join(lines)


# --- Plots ------------------------------------------------------------------------------

NODE_COLOURS = {"LEFT": "#2a78d6", "RIGHT": "#eb6834"}   # validated pair (dataviz palette 1-2)
INK, INK_2, MUTED, SURFACE = "#0b0b0b", "#52514e", "#b9b8b2", "#fcfcfb"


def plot_steps(run, result):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib is not installed: no plots.")
        return []
    roles, sign = result["roles"], result["sign"]
    written = []
    for r in result["steps"]:
        step, start, end = r["step"], r["start"], r["end"]
        fig, (top, bottom) = plt.subplots(2, 1, figsize=(11, 7), sharex=True,
                                          gridspec_kw={"height_ratios": [3, 2]})
        fig.patch.set_facecolor(SURFACE)
        for ax in (top, bottom):
            ax.set_facecolor(SURFACE)
            ax.grid(True, color="#e6e5e0", linewidth=0.6)
            for spine in ("top", "right"):
                ax.spines[spine].set_visible(False)
            for spine in ("left", "bottom"):
                ax.spines[spine].set_color(MUTED)
            ax.tick_params(colors=INK_2, labelsize=9)

        # Who holds the scan turn, shaded.
        for a, b, node in turn_segments(run.turns, start, end):
            if node in roles:
                top.axvspan(a - start, b - start, color=NODE_COLOURS[roles[node]], alpha=0.08,
                            linewidth=0)

        for boundary in (COLUMN_WIDTH_CM, 2 * COLUMN_WIDTH_CM):
            top.axhline(boundary, color=MUTED, linewidth=1)
        for index, name in enumerate(COLUMN_NAMES):
            top.text(1.005, (index + 0.5) * COLUMN_WIDTH_CM, name, transform=top.get_yaxis_transform(),
                     color=INK_2, fontsize=9, va="center")
        if step.x_cm is not None:
            top.axhline(step.x_cm, color=INK_2, linewidth=1, linestyle=(0, (4, 3)))

        readings = _in_step(run.readings, step.name)
        for node, role in roles.items():
            colour = NODE_COLOURS[role]
            for state, face in ((FOUND, colour), (HALF, "none")):
                pts = [(rd.t - start, own_point(role, rd.avg, rd.angle, sign)[0]) for rd in readings
                       if rd.node == node and rd.usable and rd.state == state]
                if pts:
                    top.scatter(*zip(*pts), s=22, facecolors=face, edgecolors=colour, linewidths=1.2,
                                label=f"{role} node alone ({STATE_NAMES[state]})", zorder=3)
        game = [g for g in _in_step(run.game, step.name) if g.x is not None]
        if game:
            top.step([g.t - start for g in game], [g.x for g in game], where="post", color=INK,
                     linewidth=2, label="game x (cursor)", zorder=4)
        top.set_ylim(-10, PLAY_WIDTH_CM + 10)
        top.set_ylabel("x (cm)", color=INK_2)
        note = "" if sign == 1 else "\nnode x with the servo angles turned the other way, which fits this run"
        top.set_title(f"{step.name}: {step.spot}{note}", color=INK, fontsize=11, loc="left")
        top.legend(loc="upper left", fontsize=8, frameon=False, ncol=3)

        for node, role in roles.items():
            colour = NODE_COLOURS[role]
            for state, marker, face in ((FOUND, "o", colour), (HALF, "o", "none"), (LOST, "x", colour)):
                pts = [(rd.t - start, rd.angle) for rd in readings
                       if rd.node == node and rd.state == state and rd.angle is not None]
                if pts:
                    kwargs = {"facecolors": face, "edgecolors": colour} if marker == "o" else {"color": colour}
                    bottom.scatter(*zip(*pts), s=18, marker=marker, linewidths=1,
                                   alpha=0.5 if state == LOST else 1, **kwargs)
            stats = r["nodes"].get(role)
            if stats and stats.angle_expected is not None:
                bottom.axhline(stats.angle_expected, color=colour, linewidth=1.2,
                               linestyle=(0, (4, 3)))
                bottom.text(1.005, stats.angle_expected, f"{role} needs", color=INK_2, fontsize=8,
                            va="center", transform=bottom.get_yaxis_transform())
            bottom.axhline(inward_limit(role, sign), color=colour, linewidth=0.8, linestyle=":")
        bottom.set_ylabel("servo angle (deg)", color=INK_2)
        bottom.set_xlabel("s since recording started (shading: who holds the scan turn; "
                          "x = lost, hollow = half-found; dotted = servo limit)", color=INK_2,
                          fontsize=9)
        bottom.set_ylim(20, 170)
        fig.tight_layout()
        path = run.folder / f"plot-{step.name}.png"
        fig.savefig(path, dpi=110, facecolor=SURFACE)
        plt.close(fig)
        written.append(path)
    return written


def tape_marks(spacing_cm=GAME_SPACING_CM, depths=DEFAULT_DEPTHS_CM):
    """(spot, from the LEFT shaft, from the RIGHT shaft) in cm, along the floor
    from the point under each servo shaft. A mark at both distances at once is
    on the spot: no right angles to set out."""
    return [(step.name,
             expected_distance("LEFT", spacing_cm, step.x_cm, step.y_cm),
             expected_distance("RIGHT", spacing_cm, step.x_cm, step.y_cm))
            for step in plan_steps(spacing_cm, depths)
            if step.x_cm is not None and step.y_cm is not None]


def print_marks(spacing_cm, depths, out=print):
    out(f"Tape marks for nodes {spacing_cm:g} cm apart (shaft to shaft). Measure along the "
        "floor from the point under each servo shaft; the spot is where both distances meet.\n")
    out(_table(["spot", "from LEFT shaft (cm)", "from RIGHT shaft (cm)"],
               [[name, f"{left:.1f}", f"{right:.1f}"] for name, left, right in tape_marks(spacing_cm, depths)]))
    return 0


def report(folder, left=None, right=None, plots=True, out=print):
    run = load_run(folder)
    result = analyse(run, left, right)
    text = format_report(run, result)
    (run.folder / "report.md").write_text(text, encoding="utf-8")
    if plots:
        plot_steps(run, result)
    out(text)
    out(f"\nReport written to {run.folder / 'report.md'}")
    return 0


# --- Command line ----------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0].strip(),
                                     formatter_class=argparse.RawDescriptionHelpFormatter,
                                     epilog=__doc__.split("\n\n", 1)[1])
    sub = parser.add_subparsers(dest="command", required=True)
    root = Path(__file__).resolve().parents[2]

    run_parser = sub.add_parser("run", help="walk through the spots and log them")
    run_parser.add_argument("--spacing-cm", type=float, default=GAME_SPACING_CM,
                            help="measured distance between the two servo shafts (default 100)")
    run_parser.add_argument("--depths", type=float, nargs="+", default=list(DEFAULT_DEPTHS_CM),
                            help="how far out the centre spots are, cm (default 40 80 120)")
    run_parser.add_argument("--steps", nargs="+", help="only these steps, e.g. C-80 L-80")
    run_parser.add_argument("--seconds", type=float, default=DEFAULT_STILL_S,
                            help="recording per still spot (default 20)")
    run_parser.add_argument("--walk-seconds", type=float, default=DEFAULT_WALK_S,
                            help="recording per walk (default 30)")
    run_parser.add_argument("--settle", type=float, default=DEFAULT_SETTLE_S,
                            help="time to get to the spot before recording (default 8)")
    run_parser.add_argument("--auto", action="store_true",
                            help="no Enter between steps: follow the voice (testing alone)")
    run_parser.add_argument("--no-voice", dest="voice", action="store_false",
                            help="print the prompts only")
    run_parser.add_argument("--server", default=DEFAULT_SERVER, help="server address")
    run_parser.add_argument("--out", default=str(root / "logs"), help="where run folders go")
    run_parser.add_argument("--left", type=int, help="the LEFT node's id, if known")
    run_parser.add_argument("--right", type=int, help="the RIGHT node's id, if known")
    run_parser.add_argument("--no-plots", action="store_true")

    marks_parser = sub.add_parser("marks", help="tape distances for each spot")
    marks_parser.add_argument("--spacing-cm", type=float, default=GAME_SPACING_CM,
                              help="measured distance between the two servo shafts (default 100)")
    marks_parser.add_argument("--depths", type=float, nargs="+", default=list(DEFAULT_DEPTHS_CM),
                              help="how far out the centre spots are, cm (default 40 80 120)")

    report_parser = sub.add_parser("report", help="report on a run folder again")
    report_parser.add_argument("folder", help="a logs/centre-* folder")
    report_parser.add_argument("--left", type=int, help="the LEFT node's id")
    report_parser.add_argument("--right", type=int, help="the RIGHT node's id")
    report_parser.add_argument("--no-plots", action="store_true")

    args = parser.parse_args(argv)
    if args.command == "marks":
        return print_marks(args.spacing_cm, args.depths)
    if args.command == "run":
        try:
            return asyncio.run(run_test(args))
        except KeyboardInterrupt:
            # Stopped part way: report on the spots that finished.
            folder = getattr(args, "run_folder", None)
            print("\nStopped.")
            if folder is not None and load_run(folder).steps:
                return report(folder, left=args.left, right=args.right, plots=not args.no_plots)
            return 130
    return report(args.folder, left=args.left, right=args.right, plots=not args.no_plots)


if __name__ == "__main__":
    sys.exit(main())
