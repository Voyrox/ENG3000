import asyncio
from collections import deque
import json
import os
import socket
import threading
import time
from flask import Flask, abort, jsonify, render_template, request
from websockets.asyncio.server import broadcast, serve
import numpy as np

from filterRules import FilterConfig
from handover import Handover
from search import CHECK_READINGS, Search, cell_name
from serverFilter import ServerFilterStage, server_filtering_enabled
from sessionRecorder import SessionRecorder
from tracking import ConstantVelocityTracker


def fft_filter_ultrasonic(readings, sample_rate_hz, cutoff_hz):
    """Low-pass a window of readings through the FFT; returns the window.

    The window's least-squares straight line is taken out first and added
    back after, and what is left is mirrored at the newest end before the
    transform. Both stop the FFT treating the window as a loop: with only the
    mean taken out, the oldest readings wrapped round onto the newest, and a
    player walking at 50 cm/s read about 35 cm behind where they were.
    filterRules.fft_lowpass_last() is the same filter read at the newest
    sample only; the game's copy is fftLowpassLast() in game.js.
    """
    signal = np.asarray(readings, dtype=float)
    n = len(signal)
    if n == 0:
        raise ValueError("fft_filter_ultrasonic needs at least one reading")
    if n < 2:
        return signal.copy()

    # Take out the straight-line trend (it is added back at the end)
    t = np.arange(n)
    slope, intercept = np.polyfit(t, signal, 1)
    trend = intercept + slope * t
    residual = signal - trend

    # Mirror at the newest end, so the two ends of the transform meet smoothly
    mirrored = np.concatenate([residual, residual[::-1]])

    # FFT for real-valued signal, and its frequency bins in Hz
    fft_signal = np.fft.rfft(mirrored)
    frequencies = np.fft.rfftfreq(2 * n, d=1.0 / sample_rate_hz)

    # Remove frequency components above cutoff
    fft_signal[frequencies > cutoff_hz] = 0

    # Back to the time domain: the first half is the original window
    clean_signal = np.fft.irfft(fft_signal, n=2 * n)[:n]

    # Restore the trend
    return clean_signal + trend


app = Flask(__name__, template_folder="template", static_folder="public", static_url_path="/static")

TCP_HOST = "0.0.0.0"
TCP_PORT = 3000
WS_HOST = "0.0.0.0"
WS_PORT = 8765
NODE_STALE_SECONDS = 5
RPS_WINDOW_SECONDS = 1
HANDSHAKE_READ_LIMIT = 64
HANDSHAKE_TIMEOUT_SECONDS = 1
# Each node's filtered_distance: median -> Kalman -> FFT low-pass. Noise and
# cutoff settings match the game's chain; unlike the browser, this per-node
# chain resets on a bearing change and uses measured timing for the FFT.
_DISTANCE_CHAIN = FilterConfig()
MEDIAN_WINDOW = _DISTANCE_CHAIN.median_window
FFT_WINDOW = _DISTANCE_CHAIN.fft_window
FFT_MIN_SAMPLES = _DISTANCE_CHAIN.fft_min_samples
DISTANCE_CUTOFF_HZ = _DISTANCE_CHAIN.fft_cutoff_hz
TURN_INTERVAL_SECONDS = 1.0
MS_PER_SECOND = 1000.0
# Server-side filtering (filterRules.py) runs only when the SERVER_FILTERING
# environment variable is set to 1/true/yes/on. Off by default: the browser
# keeps filtering in game.js and the messages are exactly as before.
SERVER_FILTERING = server_filtering_enabled(os.environ)
# The phone control panel (/control) only exists when explicitly switched on:
#   CON=1 python app.py
CONTROL_ENABLED = os.environ.get("CON") == "1"
# "position" is the position switch: Dynamic, line of sight, trilateration or their average.
# "compare" turns Compare's rings (each method's position) on the control panel's pad on or off.
# "lostReadings" sets how many readings each node's lost score is taken over
# (Out of bounds when both nodes are lost).
# "kalman" turns the game's Kalman filters on or off.
# "angleLimit" turns the angle limit on or off (a node's reading further than
# its servo line runs on the grid is dropped by every method but trilateration).
# "triAimTolerance" turns trilateration's aim tolerance on or off (its beam
# check lets a crossing be 20 degrees further off each servo's aim).
# "dynamicRules" turns Dynamic's rules on or off (a node at the confidence
# level, the far corners, the column lock, a lone node).
# "confidenceLevel" sets the confidence, in percent, at which a node places the
# player on its own (Dynamic's first rule).
# "farHalf" turns Far half on or off (a half reading in the back row counts as
# found towards Out of bounds).
# "deadZone" turns the dead zone on or off (too close by a reading's depth
# along its servo line, or by the reading itself).
# "trackMoving" turns tracking on or off (while the player moves, the cell
# decision follows them).
# "cellDecision" turns the cell decision on or off (the margin, the dwell and
# each node against itself; off, the older vote).
# "cellLock" turns the cell lock on or off (the game's cursor, and the hole it
# scores in, keep to the voted cell).
# "tooCloseHold" is the hold button: the too-close screen while it is down,
# re-sent every 250 ms while held.
CONTROL_ACTIONS = {"point", "release", "start", "mode", "pause", "resume", "restart", "menu", "testMode",
                   "position", "compare", "lostReadings", "kalman", "angleLimit", "triAimTolerance",
                   "dynamicRules", "confidenceLevel", "farHalf", "deadZone", "cellLock", "cellDecision", "trackMoving",
                   "tooCloseHold"}
# Sent many times a second while a finger is down, so not printed.
QUIET_CONTROL_ACTIONS = {"point", "release", "tooCloseHold"}
# Every raw node reading to logs/raw-*.csv, for the bench noise test
# (tools/bench_noise.py). Off unless started with REC=1; see sessionRecorder.py.
recorder = SessionRecorder.from_env(os.environ)
# When one node has seen the player in one place for 5 s, the other is aimed at
# them with LOOK <deg> (handover.py). Each node's confidence is always worked
# out and sent with nodes:update; HANDOVER=0 only stops the LOOKs, for runs to
# compare with and without. The control panel's Handover switch does the same
# while running (set_handover).
handover = Handover(steer=os.environ.get("HANDOVER") != "0")
# A node that loses the player is first aimed back at the cell the player most
# likely is in, for a few readings, before it sweeps (search.py; Aaron, 6 Oct).
# Its LOOKs go before the handover's. SEARCH=0 starts with it off; the control
# panel's Search switch turns it off and on while running (set_search).
search = Search(enabled=os.environ.get("SEARCH") != "0")

state_lock = threading.Lock()
next_node_id = 1
nodes = {}
sync_tick = 0
BROWSER_CONNECTIONS = set()
CONTROL_CONNECTIONS = set()
WS_LOOP = None
# Guarded by state_lock. None when the flag is off.
server_filter = ServerFilterStage() if SERVER_FILTERING else None


def alloc_node_id():
    global next_node_id
    node_id = next_node_id
    next_node_id += 1
    return node_id


def new_node(address, device_id=None):
    return {
        "id": None,
        "address": f"{address[0]}:{address[1]}",
        "device_id": device_id,
        "latest": None,
        "online": True,
        "last_seen": time.monotonic(),
        "samples": deque(),
        "median_samples": deque(maxlen=MEDIAN_WINDOW),
        "distance_tracker": new_distance_tracker(),
        "distance_samples": deque(maxlen=FFT_WINDOW),
        "distance_times": deque(maxlen=FFT_WINDOW),
        "distance_angle": None,
        "filtered_distance": None,
        "rps": 0.0,
        "conn": None,
        "conn_lock": threading.Lock(),
        "synced": False,
        "has_turn": False,
        "turn_since": None,     # time.monotonic() when the current turn was granted
    }


def serialize_node(node):
    return {
        "id": node["id"],
        "address": node["address"],
        "latest": node["latest"],
        "filtered_distance": node["filtered_distance"],
        "online": node["online"],
        "last_seen": node["last_seen"],
        "rps": node["rps"],
        "synced": node["synced"],
        "has_turn": node["has_turn"],
        # How sure the node is of where the player is, and which node it is
        # being aimed by (handover.py); None before calibration gives it a role
        # and after it goes offline.
        "confidence": handover.status(node["id"], node_roles.get(node["id"]), time.monotonic()),
        # Whether it is checking a cell before it sweeps, or sweeping after
        # one (search.py); None otherwise.
        "search": search.status(node["id"]),
    }


def node_confidence(now_s):
    """Each node's confidence, 0-1, for Dynamic's first rule on the server, as
    the game reads it from nodes:update: {node id: score}, or None for a node
    whose confidence is not ready (handover.py status())."""
    out = {}
    for node_id in nodes:
        status = handover.status(node_id, node_roles.get(node_id), now_s)
        out[node_id] = status["score"] if status and status["ready"] else None
    return out


def snapshot_nodes():
    with state_lock:
        return [serialize_node(node) for node in nodes.values()]


def nodes_message():
    """The nodes:update payload. With server filtering on it gains the
    "coordinate" and "predicted_cm" fields; the existing fields never change."""
    with state_lock:
        message = {"type": "nodes:update",
                   "nodes": [serialize_node(node) for node in nodes.values()]}
        if server_filter is not None:
            latest = server_filter.latest
            message["coordinate"] = latest.to_dict() if latest is not None else None
            # A copy: the stage edits its list in place when a node drops out,
            # and the message is serialised after the lock is released.
            message["predicted_cm"] = list(server_filter.predicted_cm)
    return message


async def broadcast_nodes():
    message = json.dumps(nodes_message())
    targets = BROWSER_CONNECTIONS | CONTROL_CONNECTIONS
    if targets:
        broadcast(targets, message)


def schedule_broadcast_nodes():
    if WS_LOOP is not None and WS_LOOP.is_running():
        asyncio.run_coroutine_threadsafe(broadcast_nodes(), WS_LOOP)


def find_known_node(claimed_node_id, device_id):
    if device_id:
        for existing in nodes.values():
            if existing.get("device_id") == device_id:
                return existing
    if claimed_node_id is not None and claimed_node_id in nodes:
        return nodes[claimed_node_id]
    return None


def reuse_or_register_node(address, claimed_node_id, device_id=None, conn=None):
    """Claim a node id for a connection, reusing the device's existing slot.

    `conn` is adopted inside the same lock that hands out the id, which is the
    point. The session that is taking a node over owns it from the instant it is
    named, with no gap in between: a gap is a window in which this session's
    `finally` would find the node unowned and retire it, and a reconnect that
    landed in that window would be marked offline by the session it replaced.
    """
    with state_lock:
        node = find_known_node(claimed_node_id, device_id)
        if node is not None:
            reused_existing = True
            node["address"] = f"{address[0]}:{address[1]}"
            node["online"] = True
            node["last_seen"] = time.monotonic()
            node["rps"] = 0.0
            node["samples"].clear()
            node["median_samples"].clear()
            node["distance_tracker"].reset()
            node["distance_samples"].clear()
            node["distance_times"].clear()
            node["distance_angle"] = None
            node["filtered_distance"] = None
            node["synced"] = False
            node["has_turn"] = False
            node["conn"] = conn
            if device_id:
                node["device_id"] = device_id
            node_id = node["id"]
        else:
            reused_existing = False
            node_id = alloc_node_id()
            record = new_node(address, device_id)
            record["id"] = node_id
            record["conn"] = conn
            nodes[node_id] = record
    schedule_broadcast_nodes()
    return node_id, reused_existing


def parse_message(message):
    try:
        return json.loads(message)
    except json.JSONDecodeError:
        return {}


def drop_duplicate_device(keep_node_id, device_id):
    """A device's MAC is unique: remove any other node registered with it."""
    for other_id, other in list(nodes.items()):
        if other_id != keep_node_id and other.get("device_id") == device_id:
            del nodes[other_id]


def update_rate(node, now):
    samples = node["samples"]
    samples.append(now)
    cutoff = now - RPS_WINDOW_SECONDS
    while samples and samples[0] < cutoff:
        samples.popleft()
    node["rps"] = float(len(samples)) / float(RPS_WINDOW_SECONDS)


def parse_angle_deg(payload):
    """The servo angle a scanner node read its distance at, or None."""
    angle = payload.get("angle")
    try:
        angle = float(angle)
    except (TypeError, ValueError):
        return None
    return angle if np.isfinite(angle) else None


def parse_scan_state(payload):
    """What a scanner node's scan made of its reading: 0 found, 1 half-found,
    2 lost (sweeping). None for firmware that does not say."""
    state = payload.get("scanState", payload.get("state"))
    if isinstance(state, bool):
        return None
    try:
        state = int(state)
    except (TypeError, ValueError):
        return None
    return state if state in (0, 1, 2) else None


def parse_distance_cm(payload):
    """The raw distance in a node message, as sent: negative means no echo."""
    distance = payload.get("distance")
    if distance is None:
        distance = payload.get("avg")
    if distance is not None:
        try:
            distance = float(distance)
        except (TypeError, ValueError):
            distance = None
    return distance if distance is None or np.isfinite(distance) else None


def parse_nearest_echo_cm(payload):
    """The nearer of a node's two sensors' echoes ("left", "right"), which is
    what the firmware's far hold goes by; the distance as sent from firmware
    that does not send them. None or negative means no echo."""
    echoes = []
    for side in ("left", "right"):
        try:
            echo = float(payload.get(side))
        except (TypeError, ValueError):
            continue
        if np.isfinite(echo) and echo > 0:
            echoes.append(echo)
    if echoes:
        return min(echoes)
    if "left" in payload or "right" in payload:
        return None
    return parse_distance_cm(payload)


def new_distance_tracker():
    return ConstantVelocityTracker(sigma_a_cm_s2=_DISTANCE_CHAIN.kalman_sigma_a_cm_s2,
                                   sigma_r_cm=_DISTANCE_CHAIN.kalman_sigma_r_cm)


def update_distance(node, payload, now):
    """Condition one echo at its measured servo angle, then publish its range.

    A range at a different bearing describes a different point in space. Never
    carry a median, Kalman velocity or FFT history across a change in bearing.
    The FFT assumes evenly spaced samples, so skip it for irregular scan timing.
    There is no slew gate or hold here (the game's chain, and filterRules.py's,
    have both): this value is published in nodes:update and /api/nodes, and
    nothing in the game reads it.
    """
    distance = parse_distance_cm(payload)
    # No distance, or no echo (negative): nothing to filter, and the last value
    # stands. A -1 in the median window would drag it towards zero. A NaN or
    # +/-inf is missing too: in the window it would make the median, the
    # Kalman's input and the FFT history NaN.
    if distance is None or not np.isfinite(distance) or distance < 0:
        return

    angle = parse_angle_deg(payload)
    medians = node["median_samples"]
    tracker = node["distance_tracker"]
    history = node["distance_samples"]
    times = node["distance_times"]
    # A new bearing, or a gap (a node waits out the other node's scanning
    # turn, for one): the Kalman starts a new track and the windows start again.
    if angle != node["distance_angle"] or (tracker.alive and
            now - tracker.t_reading_s > tracker.gap_reset_s):
        medians.clear()
        tracker.reset()
        history.clear()
        times.clear()
    node["distance_angle"] = angle

    medians.append(distance)
    # The upper of the two middle values when the window is even, as the
    # game's median (and filterRules.py's) takes.
    ordered = sorted(medians)
    tracked = tracker.update(float(ordered[len(ordered) // 2]), now)
    history.append(tracked)
    times.append(now)
    node["filtered_distance"] = float(tracked)
    if len(history) < FFT_MIN_SAMPLES:
        return

    intervals = np.diff(times)
    # A missed pulse or a changed reporting rate breaks the uniformly sampled
    # FFT model. Kalman still uses the actual timestamps in that case.
    if np.any(intervals <= 0):
        return
    period = float(np.median(intervals))
    if np.any(np.abs(intervals - period) > 0.2 * period):
        return
    node["filtered_distance"] = float(fft_filter_ultrasonic(
        history, 1.0 / period, DISTANCE_CUTOFF_HZ)[-1])


def ms_since_turn(node, now):
    """How long the node has held its scan turn, in ms; None without one."""
    since = node.get("turn_since")
    if not node["has_turn"] or since is None:
        return None
    return (now - since) * MS_PER_SECOND


def update_node(node_id, message):
    with state_lock:
        node = nodes.get(node_id)
        if node is None:
            return
        now = time.monotonic()
        payload = parse_message(message)

        device_id = payload.get("mac")
        if device_id:
            drop_duplicate_device(node_id, device_id)
            node["device_id"] = device_id

        node["latest"] = message
        node["online"] = True
        node["last_seen"] = now
        update_rate(node, now)
        update_distance(node, payload, now)
        room = payload.get("room")
        room = room if isinstance(room, int) else None
        handover.record(node_id, parse_distance_cm(payload), parse_angle_deg(payload), now,
                        room=room)
        search_look = search.record(node_id, node_roles.get(node_id), parse_scan_state(payload),
                                    parse_nearest_echo_cm(payload), parse_angle_deg(payload), now,
                                    room=room, far_hold=nodes_far["hold"], held=nodes_aim_held)
        looks = handover.commands(dict(node_roles),
                                  {other_id: other["has_turn"] for other_id, other in nodes.items()},
                                  now, held=nodes_aim_held,
                                  busy={other_id for other_id in nodes if search.checking(other_id)})
        for look in looks:
            search.looked(look.node_id)
        if recorder is not None:
            recorder.record(node_id, payload, role=node_roles.get(node_id),
                            has_turn=node["has_turn"], ms_since_turn=ms_since_turn(node, now),
                            pulses=nodes_pulse_count, received_at=now)

        if server_filter is not None:
            # RAW distance, never node["filtered_distance"]: the chain does its
            # own filtering and the proximity guard needs unsmoothed readings.
            raw_cm = parse_distance_cm(payload)
            if raw_cm is not None:
                server_filter.on_reading(node_id, raw_cm, now * MS_PER_SECOND,
                                         angle_deg=parse_angle_deg(payload),
                                         scan_state=parse_scan_state(payload),
                                         confidence=node_confidence(now))
    schedule_broadcast_nodes()

    # Sent once state_lock is released, because send_command takes it too.
    if search_look is not None:
        print(f"Search: node {search_look.node_id} {search_look.command}, checking the "
              f"{cell_name(search_look.cell)} cell ({search_look.checks}/{CHECK_READINGS} read)")
        send_command(search_look.node_id, search_look.command)
    for look in looks:
        print(f"Handover: node {look.node_id} {look.command}, towards node {look.source_id}'s "
              f"fix at ({look.point[0]:.0f}, {look.point[1]:.0f}) cm +/-{look.spread_cm:.0f}")
        send_command(look.node_id, look.command)


def mark_node_offline(node_id, conn=None):
    """Take a node offline, unless a newer connection has already taken it over.

    A node that drops and reconnects is the normal case, and the two sessions
    overlap: the old socket's handler can still reach its `finally` after the new
    one has registered. Marking the node offline from the old session then wipes
    the live connection's state, and the node goes dark until it reconnects a
    third time. Passing the connection that is going away means the only session
    allowed to retire the node is the one that is actually leaving.
    """
    with state_lock:
        node = nodes.get(node_id)
        if node is None:
            return
        if conn is not None and node.get("conn") is not conn:
            return
        node["online"] = False
        node["rps"] = 0.0
        node["samples"].clear()
        node["synced"] = False
        node["has_turn"] = False
        node["conn"] = None
        handover.forget(node_id)
        search.forget(node_id)
        if server_filter is not None:
            server_filter.on_missing(node_id)
    schedule_broadcast_nodes()


def read_handshake_line(conn):
    buffer = bytearray()
    while len(buffer) < HANDSHAKE_READ_LIMIT:
        try:
            chunk = conn.recv(1)
        except TimeoutError:
            break
        if not chunk:
            break
        if chunk == b"\n":
            break
        if chunk != b"\r":
            buffer.extend(chunk)

    return buffer.decode("utf-8").strip()


def parse_handshake(raw_line):
    if not raw_line:
        return None, None

    claimed_node_id = None
    device_id = None

    try:
        claimed_node_id = int(raw_line)
    except ValueError:
        payload = parse_message(raw_line)
        if not payload:
            return None, None
        claimed_node_id = payload.get("nodeId")
        device_id = payload.get("mac")

    if claimed_node_id is not None and claimed_node_id < 0:
        claimed_node_id = None

    return claimed_node_id, device_id


def cleanup_stale_nodes():
    while True:
        time.sleep(1)
        cutoff = time.monotonic() - NODE_STALE_SECONDS
        stale_ids = []
        with state_lock:
            for node_id, node in list(nodes.items()):
                if node.get("online") and node.get("last_seen", 0) < cutoff:
                    node["online"] = False
                    node["rps"] = 0.0
                    node["samples"].clear()
                    if server_filter is not None:
                        server_filter.on_missing(node_id)
                    stale_ids.append(node_id)
                    # `conn` is deliberately left alone. Holding a live socket is
                    # what keeps this node in the coordinator's turn rotation, and
                    # clearing it here would take a merely quiet node out of the
                    # schedule for good. The socket's own handler retires the node
                    # via mark_node_offline when the connection really ends.

        for node_id in stale_ids:
            print(f"Node {node_id} timed out")
        if stale_ids:
            schedule_broadcast_nodes()


def send_command(node_id, command):
    """Send a CRLF-free control line to a node, respecting its conn lock."""
    with state_lock:
        node = nodes.get(node_id)
        conn = node["conn"] if node is not None else None
        conn_lock = node["conn_lock"] if node is not None else None
    if conn is None or conn_lock is None:
        return
    with conn_lock:
        try:
            conn.sendall((command + "\n").encode("utf-8"))
        except (OSError, TimeoutError):
            pass


# Which node is LEFT and which is RIGHT, as identified on the game's calibration
# screen (node id -> "LEFT" | "RIGHT"). Each scanner node needs its role for
# its servo limits; it is sent on assignment and again whenever the node
# reconnects, since a rebooted ESP32 has forgotten it.
NODE_ROLE_NAMES = {0: "LEFT", 2: "RIGHT"}   # slot index in [left, centre, right]
node_roles = {}


def assign_node_roles(slots):
    """Record the browser's [left, centre, right] node ids and tell each node."""
    if not isinstance(slots, list) or len(slots) != 3:
        print(f"Ignored bad sensors:assign slots: {slots!r}")
        return
    roles = {slots[index]: role for index, role in NODE_ROLE_NAMES.items()
             if isinstance(slots[index], int)}
    with state_lock:
        node_roles.clear()
        node_roles.update(roles)
    for node_id, role in roles.items():
        send_command(node_id, f"ROLE {role}")


# Calibration holds every node's servo at 90 degrees so the nodes can be aimed
# straight out by hand; otherwise they scan. Each game page says whether it is
# on the calibration screen (nodes:aim), and the servos stay held while any page
# is: another tab or device opening on the menu must not set them sweeping in
# the middle of someone's calibration. A node is told AIM or SCAN on arrival.
AIM_ANGLE_DEG = 90
nodes_aim_held = False
aim_requesters = set()          # the game pages on the calibration screen
aim_lock = threading.Lock()     # one hold/release decided and sent at a time


def aim_command():
    return f"AIM {AIM_ANGLE_DEG}" if nodes_aim_held else "SCAN"


def set_nodes_aim(hold):
    """Hold every connected node's servo straight, or let them all scan."""
    global nodes_aim_held
    with state_lock:
        nodes_aim_held = bool(hold)
        command = aim_command()
        node_ids = [node_id for node_id, node in nodes.items() if node.get("conn") is not None]
    for node_id in node_ids:
        send_command(node_id, command)


def request_nodes_aim(requester, hold):
    """One game page arriving on (hold) or leaving the calibration screen. The
    nodes are only told when that changes whether any page is on it."""
    with aim_lock:
        with state_lock:
            if hold:
                aim_requesters.add(requester)
            else:
                aim_requesters.discard(requester)
            wanted = bool(aim_requesters)
            changed = wanted != nodes_aim_held
        if changed:
            set_nodes_aim(wanted)


def send_node_aim(node_id):
    """Tell a node that has just connected to hold straight or to scan. It
    boots holding, so it scans only once told to."""
    with state_lock:
        command = aim_command()
    send_command(node_id, command)


def send_node_role(node_id):
    """Re-send a known role, e.g. after the node reconnects."""
    with state_lock:
        role = node_roles.get(node_id)
    if role is not None:
        send_command(node_id, f"ROLE {role}")


# Multi-pulse, switched with the Pulses button on the game screen (nodes:pulses).
# In found or half-found, each scanner node takes this many pulse pairs at one
# angle and averages them, outliers left out, before it reports and moves; 1 is
# off. Every node is told on arrival (a rebooted node has forgotten) and again
# whenever the game changes it.
PULSE_COUNT_OPTIONS = (1, 2, 3)
nodes_pulse_count = 1


def pulses_command():
    return f"PULSES {nodes_pulse_count}"


def set_nodes_pulse_count(count):
    """Set pulses per angle on every connected node. Anything but one of
    PULSE_COUNT_OPTIONS is ignored. Returns whether the count was taken."""
    global nodes_pulse_count
    if not isinstance(count, int) or isinstance(count, bool) or count not in PULSE_COUNT_OPTIONS:
        print(f"Ignored bad nodes:pulses count: {count!r}")
        return False
    with state_lock:
        nodes_pulse_count = count
        command = pulses_command()
        node_ids = [node_id for node_id, node in nodes.items() if node.get("conn") is not None]
    print(f"Multi-pulse: {count} pulse pair(s) per angle")
    for node_id in node_ids:
        send_command(node_id, command)
    return True


def send_node_pulses(node_id):
    """Tell a node that has just connected how many pulses to take per angle."""
    with state_lock:
        command = pulses_command()
    send_command(node_id, command)


# Far hold and far steer (Aaron, 6 Oct), the control panel's two switches, both
# on: after an echo 100 cm or more out, a scanner node keeps its servo still for
# up to 3 lost pairs before it sweeps (FARHOLD), and a far half-found echo
# steers it 1 degree instead of 3 (FARSTEER); see src/Config.h. The server
# holds the setting: every node is told on arrival (a rebooted node starts with
# both on) and again whenever a switch changes.
FAR_COMMANDS = {"hold": "FARHOLD", "steer": "FARSTEER"}
nodes_far = {"hold": True, "steer": True}


def far_command(switch):
    return f"{FAR_COMMANDS[switch]} {1 if nodes_far[switch] else 0}"


def set_nodes_far(switch, on):
    """Turn far hold ("hold") or far steer ("steer") on or off on every
    connected node. Anything but one of those, or a value that is not
    true/false, is ignored. Returns whether it was taken."""
    if switch not in FAR_COMMANDS or not isinstance(on, bool):
        print(f"Ignored bad far switch: {switch!r}={on!r}")
        return False
    with state_lock:
        nodes_far[switch] = on
        command = far_command(switch)
        node_ids = [node_id for node_id, node in nodes.items() if node.get("conn") is not None]
    print(f"Far {switch}: {'on' if on else 'off'} (control panel)")
    for node_id in node_ids:
        send_command(node_id, command)
    return True


def send_node_far(node_id):
    """Tell a node that has just connected whether far hold and far steer are on."""
    with state_lock:
        commands = [far_command(switch) for switch in FAR_COMMANDS]
    for command in commands:
        send_command(node_id, command)


def far_message():
    """What the control panel's Far hold and Far steer switches show."""
    return {"type": "far:status", "hold": nodes_far["hold"], "steer": nodes_far["steer"]}


# The empty room, from the Room button on the game screen (nodes:room), the
# control panel's Learn room / Forget room ("room" action) or POST /api/room. LEARN: with nobody in the play area, each scanner node sweeps
# its range and records the room's echoes, and from then on ignores them.
# FORGET clears that. The nodes keep the room in flash and report it in every
# reading ("room": 0 not learnt, 1 learning, 2 learnt), so a node that
# reconnects is not told again.
ROOM_COMMANDS = {"learn": "LEARN", "forget": "FORGET"}


def send_nodes_room(action):
    """Tell every connected node to learn or forget the room. Anything but an
    action in ROOM_COMMANDS is ignored. Returns whether it was sent."""
    command = ROOM_COMMANDS.get(action) if isinstance(action, str) else None
    if command is None:
        print(f"Ignored bad nodes:room action: {action!r}")
        return False
    with state_lock:
        node_ids = [node_id for node_id, node in nodes.items() if node.get("conn") is not None]
    print(f"Room: {action} on {len(node_ids)} node(s)")
    for node_id in node_ids:
        send_command(node_id, command)
    return True


def sync_node(node_id):
    """Send the authoritative tick to one node (PC is source of truth)."""
    with state_lock:
        tick = sync_tick
        node = nodes.get(node_id)
        if node is None:
            return
        node["synced"] = True
    send_command(node_id, f"SYNC {tick}")


def set_turn(node_id, granted):
    """Grant or revoke a scan slot. Mutually exclusive across nodes."""
    with state_lock:
        node = nodes.get(node_id)
        if node is None:
            return
        if granted and not node["has_turn"]:
            node["turn_since"] = time.monotonic()
        elif not granted:
            node["turn_since"] = None
        node["has_turn"] = granted
    send_command(node_id, "TURN" if granted else "HALT")
    schedule_broadcast_nodes()


def coordinator_loop():
    """The PC is the source of truth: alternate scan turns across all online
    nodes on a fixed schedule so two ultrasonic sensors never fire together.
    """
    global sync_tick
    while True:
        time.sleep(TURN_INTERVAL_SECONDS)
        sync_tick += 1
        with state_lock:
            # A live socket is the proof of life, not the `online` flag. Those
            # two used to be conflated here, which is a one-way ratchet now that
            # the firmware obeys HALT: a node only reports while it holds the
            # turn, so a node that goes quiet for NODE_STALE_SECONDS is marked
            # offline by cleanup_stale_nodes, which then drops it from this list,
            # so it is never granted a turn again, so it never reports again --
            # stuck offline for good behind a perfectly healthy connection.
            # Trust the connection and let staleness stay a display concern.
            online_ids = sorted(
                node_id for node_id, node in nodes.items()
                if node.get("conn") is not None
            )
        if not online_ids:
            continue

        # One tick of authority for every node, then the next node scans.
        for node_id in online_ids:
            sync_node(node_id)

        active = online_ids[sync_tick % len(online_ids)]
        # Revoke every other turn before granting the next one, regardless of
        # node ID order. Never send TURN while another node is still authorized.
        for node_id in online_ids:
            if node_id != active:
                set_turn(node_id, False)
        set_turn(active, True)

        print(
            f"Tick {sync_tick}: scanning node {active}, "
            f"waiting: {[n for n in online_ids if n != active]}"
        )


def handle_node_connection(conn, address):
    node_id = None
    first_message = None
    conn.settimeout(HANDSHAKE_TIMEOUT_SECONDS)
    try:
        raw_handshake = read_handshake_line(conn)
        claimed_node_id, device_id = parse_handshake(raw_handshake)
        if raw_handshake.startswith("{"):
            first_message = raw_handshake
        elif raw_handshake and claimed_node_id is None:
            first_message = raw_handshake
        conn.settimeout(None)
        node_id, reused_existing = reuse_or_register_node(
            address, claimed_node_id, device_id, conn=conn
        )
        action = "restored" if reused_existing else "assigned"
        print(f"ESP32 connected from {address}, {action} id {node_id}")
        conn.sendall(f"{node_id}\n".encode("utf-8"))
        # A rebooted node has forgotten whether it should be holding straight
        # for calibration, which mount it is, how many pulses to take and
        # whether far hold and far steer are on; tell it again.
        send_node_aim(node_id)
        send_node_role(node_id)
        send_node_pulses(node_id)
        send_node_far(node_id)
        if first_message is not None:
            update_node(node_id, first_message)
        with conn.makefile("r") as stream:
            for line in stream:
                message = line.strip()
                if not message:
                    continue
                update_node(node_id, message)
    except (OSError, TimeoutError) as exc:
        print(f"Node {node_id if node_id is not None else 'unknown'} disconnected: {exc}")
    finally:
        # Scoped to this session, so a reconnect already in flight is left alone.
        if node_id is not None:
            mark_node_offline(node_id, conn)
        conn.close()


def tcp_server():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((TCP_HOST, TCP_PORT))
    server.listen()
    print(f"TCP broker listening on {TCP_HOST}:{TCP_PORT}")

    while True:
        conn, address = server.accept()
        thread = threading.Thread(target=handle_node_connection, args=(conn, address), daemon=True)
        thread.start()


def apply_filter_event(event):
    """Sensor order and calibration for server-side filtering. Both are only
    known in the browser (calibrate.js, callibrate_corners.js)."""
    try:
        with state_lock:
            if event.get("type") == "sensors:assign":
                server_filter.assign_slots(event["slots"])
            elif event.get("type") == "calibration:update":
                server_filter.set_calibration(
                    [(c["near"], c["far"]) for c in event["perColumn"]])
            elif event.get("type") == "position:method":
                # The game's position switch: Dynamic, line of sight, trilateration or both.
                server_filter.set_position_method(event["method"])
            elif event.get("type") == "sensor:lostReadings":
                # The readings each node's lost score is taken over, from the
                # control panel by way of the game.
                server_filter.set_lost_readings(event["count"])
            elif event.get("type") == "filter:kalman":
                # The control panel's Kalman switch, passed on by the game.
                server_filter.set_kalman(bool(event["on"]))
            elif event.get("type") == "filter:angleLimit":
                # The control panel's angle limit switch, passed on by the game.
                server_filter.set_angle_limit(bool(event["on"]))
            elif event.get("type") == "filter:triAimTolerance":
                # The control panel's tri aim tolerance switch, passed on by the game.
                server_filter.set_tri_aim_tolerance(bool(event["on"]))
            elif event.get("type") == "filter:deadZone":
                # The control panel's dead zone switch, passed on by the game.
                server_filter.set_dead_zone(bool(event["on"]))
            elif event.get("type") == "filter:cellDecision":
                # The control panel's cell decision switch, passed on by the game.
                server_filter.set_cell_decision(bool(event["on"]))
            elif event.get("type") == "filter:trackMoving":
                # The control panel's tracking switch, passed on by the game.
                server_filter.set_track_moving(bool(event["on"]))
            elif event.get("type") == "sensor:dynamicRules":
                # Dynamic's rule switches, from the control panel by way of the game.
                server_filter.set_dynamic_rules(event["rules"])
            elif event.get("type") == "sensor:confidenceLevel":
                # The confidence level, from the control panel by way of the game.
                server_filter.set_confidence_level(event["pct"])
            elif event.get("type") == "sensor:farHalf":
                # The control panel's Far half switch, passed on by the game.
                server_filter.set_far_half(bool(event["on"]))
    except (KeyError, TypeError, ValueError) as exc:
        print(f"Ignored bad {event.get('type')} message: {exc}")


async def browser_handler(websocket):
    BROWSER_CONNECTIONS.add(websocket)
    try:
        await websocket.send(json.dumps(nodes_message()))
        async for message in websocket:
            try:
                event = json.loads(message)
            except json.JSONDecodeError:
                continue

            if event.get("type") == "menu:select":
                option = event.get("option", "unknown")
                print(f"Menu selection received: {option}")
                status = json.dumps({"type": "menu:status", "message": f"Selected: {option}"})
                broadcast(BROWSER_CONNECTIONS.copy(), status)
            elif event.get("type") == "game:status":
                # The game's state for the phone control panel; never a filter
                # event. Its cursor tells the search which cell the game shows.
                await asyncio.to_thread(note_game_status, event.get("cursor"))
                if CONTROL_CONNECTIONS:
                    broadcast(CONTROL_CONNECTIONS.copy(), message)
            elif event.get("type") in ("cells:confidence", "round:start"):
                # The game's cell confidence map, and a new round, for the search.
                await asyncio.to_thread(apply_search_event, event)
            elif event.get("type") == "calibration:update":
                # The cells' depths, for the search; and the chain's, with
                # server-side filtering on.
                await asyncio.to_thread(apply_search_event, event)
                if server_filter is not None:
                    apply_filter_event(event)
            elif event.get("type") == "sensors:assign":
                # Always: the scanner nodes need their roles whether or not the
                # server filters. With SERVER_FILTERING on, the chain uses it too.
                await asyncio.to_thread(assign_node_roles, event.get("slots"))
                if server_filter is not None:
                    apply_filter_event(event)
            elif event.get("type") == "nodes:aim":
                # This page arriving on (hold) or leaving the calibration screen.
                await asyncio.to_thread(request_nodes_aim, websocket, bool(event.get("hold")))
            elif event.get("type") == "nodes:pulses":
                # The game screen's Pulses button: multi-pulse off (1), 2 or 3.
                await asyncio.to_thread(set_nodes_pulse_count, event.get("count"))
            elif event.get("type") == "nodes:room":
                # The game screen's Room button: learn the empty room.
                await asyncio.to_thread(send_nodes_room, event.get("action"))
            elif server_filter is not None:
                apply_filter_event(event)
    finally:
        BROWSER_CONNECTIONS.discard(websocket)
        # A calibration screen that closes with its tab no longer holds the
        # servos; if it was the last one, the nodes scan again.
        await asyncio.to_thread(request_nodes_aim, websocket, False)


def note_game_status(cursor):
    """game:status's cursor (None with no round on screen), for the search."""
    with state_lock:
        search.game_status(cursor, time.monotonic())


def apply_search_event(event):
    """The game's cell confidence map (cells:confidence, nine scores, index
    gx * 3 + gy), a new round (round:start) or the corner calibration
    (calibration:update), for the search."""
    try:
        with state_lock:
            if event.get("type") == "cells:confidence":
                search.set_scores(event["scores"])
            elif event.get("type") == "round:start":
                search.reset()
            elif event.get("type") == "calibration:update":
                search.set_calibration([(c["near"], c["far"]) for c in event["perColumn"]])
    except (KeyError, TypeError, ValueError) as exc:
        print(f"Ignored bad {event.get('type')} message for the search: {exc}")


def set_search(enabled):
    """The control panel's Search switch. Off, a lost node sweeps at once, as
    SEARCH=0 has it from the start."""
    with state_lock:
        search.enabled = enabled is True
    print(f"Search: {'on' if search.enabled else 'off'} (control panel)")


def search_message():
    """What the control panel's Search switch shows."""
    return {"type": "search:status", "on": search.enabled}


def set_handover(enabled):
    """The control panel's Handover switch. Off keeps every node's confidence
    but sends no LOOK, as HANDOVER=0 does from the start."""
    handover.steer = enabled is True
    print(f"Handover: {'on' if handover.steer else 'off'} (control panel)")


def handover_message():
    """What the control panel's Handover switch shows."""
    return {"type": "handover:status", "on": handover.steer}


async def control_handler(websocket):
    """Phone control panel: relays commands to every game browser. The empty
    room ("room": learn or forget) and the Far hold and Far steer switches
    ("farHold", "farSteer") go straight to the nodes instead, so they work with
    no game page open, and the Handover and Search switches ("handover",
    "search") to the server."""
    CONTROL_CONNECTIONS.add(websocket)
    print(f"Control panel connected from {websocket.remote_address}")
    try:
        await websocket.send(json.dumps({"type": "nodes:update", "nodes": snapshot_nodes()}))
        await websocket.send(json.dumps(handover_message()))
        await websocket.send(json.dumps(search_message()))
        await websocket.send(json.dumps(far_message()))
        async for message in websocket:
            try:
                event = json.loads(message)
            except json.JSONDecodeError:
                continue
            if event.get("action") == "room":
                print(f"Control panel: {event}")
                await asyncio.to_thread(send_nodes_room, event.get("room"))
                continue
            if event.get("action") == "handover":
                set_handover(event.get("enabled"))
                broadcast(CONTROL_CONNECTIONS.copy(), json.dumps(handover_message()))
                continue
            if event.get("action") == "search":
                await asyncio.to_thread(set_search, event.get("enabled"))
                broadcast(CONTROL_CONNECTIONS.copy(), json.dumps(search_message()))
                continue
            if event.get("action") in ("farHold", "farSteer"):
                print(f"Control panel: {event}")
                switch = "hold" if event["action"] == "farHold" else "steer"
                await asyncio.to_thread(set_nodes_far, switch, event.get("enabled"))
                broadcast(CONTROL_CONNECTIONS.copy(), json.dumps(far_message()))
                continue
            if event.get("action") not in CONTROL_ACTIONS:
                continue
            if event["action"] not in QUIET_CONTROL_ACTIONS:
                print(f"Control panel: {event}")
            command = json.dumps({**event, "type": "remote:command"})
            broadcast(BROWSER_CONNECTIONS.copy(), command)
    finally:
        CONTROL_CONNECTIONS.discard(websocket)
        print("Control panel disconnected")


async def websocket_handler(websocket):
    match websocket.request.path:
        case "/browser":
            await browser_handler(websocket)
        case "/control" if CONTROL_ENABLED:
            await control_handler(websocket)
        case _:
            await websocket.close()


async def websocket_server():
    global WS_LOOP
    WS_LOOP = asyncio.get_running_loop()
    async with serve(websocket_handler, WS_HOST, WS_PORT, ping_interval=2, ping_timeout=2):
        print(f"WebSocket server listening on {WS_HOST}:{WS_PORT}")
        await asyncio.Future()


def lan_ip():
    """The laptop's address on the current network (no packet is sent)."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("10.255.255.255", 1))
        return probe.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        probe.close()


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/control")
def control():
    if not CONTROL_ENABLED:
        abort(404)
    return render_template("control.html")


@app.route("/api/nodes")
def api_nodes():
    return jsonify(snapshot_nodes())


@app.route("/api/nodes/<int:node_id>")
def api_node(node_id):
    with state_lock:
        node = nodes.get(node_id)
        if node is None:
            return jsonify({"error": "unknown node"}), 404
        return jsonify(serialize_node(node))


# The bench noise test (tools/bench_noise.py) drives these two.

@app.route("/api/recording/label", methods=["POST"])
def api_recording_label():
    """Label the raw readings recorded from now on, e.g. {"label": "p3-60cm"};
    an empty label marks readings that belong to no bench step."""
    if recorder is None:
        return jsonify({"error": "not recording: start the server with REC=1"}), 404
    body = request.get_json(silent=True) or {}
    label = recorder.set_label(body.get("label", ""))
    return jsonify({"label": label, "file": recorder.path.name})


@app.route("/api/pulses", methods=["POST"])
def api_pulses():
    """Multi-pulse without the game page: {"count": 1|2|3}, 1 = off."""
    body = request.get_json(silent=True) or {}
    count = body.get("count")
    if not set_nodes_pulse_count(count):
        return jsonify({"error": f"count must be one of {list(PULSE_COUNT_OPTIONS)}"}), 400
    return jsonify({"count": count})


@app.route("/api/room", methods=["POST"])
def api_room():
    """The empty room without the game page: {"action": "learn"|"forget"}. Each
    node's progress is the "room" field of its readings in /api/nodes."""
    body = request.get_json(silent=True) or {}
    action = body.get("action")
    if not send_nodes_room(action):
        return jsonify({"error": f"action must be one of {sorted(ROOM_COMMANDS)}"}), 400
    return jsonify({"action": action})


if __name__ == '__main__':
    threading.Thread(target=lambda: asyncio.run(websocket_server()), daemon=True).start()
    threading.Thread(target=tcp_server, daemon=True).start()
    threading.Thread(target=cleanup_stale_nodes, daemon=True).start()
    threading.Thread(target=coordinator_loop, daemon=True).start()
    if CONTROL_ENABLED:
        print(f"Control panel enabled at http://{lan_ip()}:5000/control")
    if recorder is not None:
        print(f"Recording raw readings to {recorder.path}")
    # debug=False, deliberately. The Werkzeug debugger is a remote shell on the
    # machine running the rig, and this listens on 0.0.0.0 so every device on the
    # network can reach it. Anything that trips an exception while the rig is in
    # use is a bug to read in the log, not one to hand a console to the lab.
    app.run(debug=False, host="0.0.0.0", threaded=True, use_reloader=False)
