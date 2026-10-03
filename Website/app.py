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
# "position" is the position switch: line of sight, trilateration or their average.
CONTROL_ACTIONS = {"point", "release", "start", "mode", "pause", "resume", "restart", "menu", "testMode",
                   "position"}
# Every raw node reading to logs/raw-*.csv, for the bench noise test
# (tools/bench_noise.py). Off unless started with REC=1; see sessionRecorder.py.
recorder = SessionRecorder.from_env(os.environ)

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
    }


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
    if distance is None or distance < 0:
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
                                         scan_state=parse_scan_state(payload))
    schedule_broadcast_nodes()


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
        # for calibration, which mount it is and how many pulses to take; tell
        # it again.
        send_node_aim(node_id)
        send_node_role(node_id)
        send_node_pulses(node_id)
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
                # The game's position switch: line of sight, trilateration or both.
                server_filter.set_position_method(event["method"])
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
                # The game's state for the phone control panel; never a filter event.
                if CONTROL_CONNECTIONS:
                    broadcast(CONTROL_CONNECTIONS.copy(), message)
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
            elif server_filter is not None:
                apply_filter_event(event)
    finally:
        BROWSER_CONNECTIONS.discard(websocket)
        # A calibration screen that closes with its tab no longer holds the
        # servos; if it was the last one, the nodes scan again.
        await asyncio.to_thread(request_nodes_aim, websocket, False)


async def control_handler(websocket):
    """Phone control panel: relays commands to every game browser."""
    CONTROL_CONNECTIONS.add(websocket)
    print(f"Control panel connected from {websocket.remote_address}")
    try:
        await websocket.send(json.dumps({"type": "nodes:update", "nodes": snapshot_nodes()}))
        async for message in websocket:
            try:
                event = json.loads(message)
            except json.JSONDecodeError:
                continue
            if event.get("action") not in CONTROL_ACTIONS:
                continue
            if event["action"] not in ("point", "release"):
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
