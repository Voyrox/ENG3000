import asyncio
from collections import deque
import json
import os
import socket
import threading
import time
from flask import Flask, abort, jsonify, render_template
from websockets.asyncio.server import broadcast, serve
import numpy as np

from serverFilter import ServerFilterStage, server_filtering_enabled


def fft_filter_ultrasonic(readings, sample_rate_hz, cutoff_hz):
    signal = np.asarray(readings, dtype=float)
    n = len(signal)

    # Remove DC offset before filtering
    mean = np.mean(signal)
    centered = signal - mean

    # FFT for real-valued signal
    fft_signal = np.fft.rfft(centered)

    # Frequency bins in Hz
    frequencies = np.fft.rfftfreq(n, d=1.0 / sample_rate_hz)

    # Remove frequency components above cutoff
    fft_signal[frequencies > cutoff_hz] = 0

    # Convert back to time domain
    clean_signal = np.fft.irfft(fft_signal, n=n)

    # Restore original mean
    return clean_signal + mean


app = Flask(__name__, template_folder="template", static_folder="public", static_url_path="/static")

TCP_HOST = "0.0.0.0"
TCP_PORT = 3000
WS_HOST = "0.0.0.0"
WS_PORT = 8765
NODE_STALE_SECONDS = 5
RPS_WINDOW_SECONDS = 1
HANDSHAKE_READ_LIMIT = 64
HANDSHAKE_TIMEOUT_SECONDS = 1
MEDIAN_WINDOW = 5
FFT_WINDOW = 64
FFT_MIN_SAMPLES = 16
DISTANCE_SAMPLE_RATE_HZ = 20.0
DISTANCE_CUTOFF_HZ = 2.0
TURN_INTERVAL_SECONDS = 1.0
MS_PER_SECOND = 1000.0
# Server-side filtering (filterRules.py) runs only when the SERVER_FILTERING
# environment variable is set to 1/true/yes/on. Off by default: the browser
# keeps filtering in game.js and the messages are exactly as before.
SERVER_FILTERING = server_filtering_enabled(os.environ)
# The phone control panel (/control) only exists when explicitly switched on:
#   CON=1 python app.py
CONTROL_ENABLED = os.environ.get("CON") == "1"
CONTROL_ACTIONS = {"point", "release", "start", "mode", "pause", "resume", "restart", "menu", "testMode"}

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
        "distance_samples": deque(maxlen=FFT_WINDOW),
        "filtered_distance": None,
        "rps": 0.0,
        "conn": None,
        "conn_lock": threading.Lock(),
        "synced": False,
        "has_turn": False,
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
            node["distance_samples"].clear()
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
    return distance


def update_distance(node, payload):
    distance = parse_distance_cm(payload)
    if distance is None:
        return

    medians = node["median_samples"]
    medians.append(distance)
    smoothed = float(np.median(medians))
    history = node["distance_samples"]
    history.append(smoothed)
    if len(history) >= FFT_MIN_SAMPLES:
        filtered = fft_filter_ultrasonic(history, DISTANCE_SAMPLE_RATE_HZ, DISTANCE_CUTOFF_HZ)
        node["filtered_distance"] = float(filtered[-1])
    else:
        node["filtered_distance"] = smoothed


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
        update_distance(node, payload)
        if server_filter is not None:
            # RAW distance, never node["filtered_distance"]: the chain does its
            # own filtering and the proximity guard needs unsmoothed readings.
            raw_cm = parse_distance_cm(payload)
            if raw_cm is not None:
                server_filter.on_reading(node_id, raw_cm, now * MS_PER_SECOND,
                                         angle_deg=parse_angle_deg(payload))
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
# straight out by hand; otherwise they scan. Set by the browser's calibration
# screen (nodes:aim); a node that connects mid-calibration is told on arrival.
AIM_ANGLE_DEG = 90
nodes_aim_held = False


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


def send_node_aim(node_id):
    """Tell a node that connects during calibration to hold straight too."""
    with state_lock:
        command = aim_command() if nodes_aim_held else None
    if command is not None:
        send_command(node_id, command)


def send_node_role(node_id):
    """Re-send a known role, e.g. after the node reconnects."""
    with state_lock:
        role = node_roles.get(node_id)
    if role is not None:
        send_command(node_id, f"ROLE {role}")


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
        for node_id in online_ids:
            set_turn(node_id, node_id == active)

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
        # A rebooted node has forgotten which mount it is, and whether it should
        # be holding straight for calibration; tell it again.
        send_node_role(node_id)
        send_node_aim(node_id)
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
                # The calibration screen opening (hold) or closing (release).
                await asyncio.to_thread(set_nodes_aim, bool(event.get("hold")))
            elif server_filter is not None:
                apply_filter_event(event)
    finally:
        BROWSER_CONNECTIONS.discard(websocket)
        # The calibration screen that asked for the hold went with its tab: let
        # the nodes scan again rather than stay frozen at 90 degrees.
        if not BROWSER_CONNECTIONS and nodes_aim_held:
            await asyncio.to_thread(set_nodes_aim, False)


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


if __name__ == '__main__':
    threading.Thread(target=lambda: asyncio.run(websocket_server()), daemon=True).start()
    threading.Thread(target=tcp_server, daemon=True).start()
    threading.Thread(target=cleanup_stale_nodes, daemon=True).start()
    threading.Thread(target=coordinator_loop, daemon=True).start()
    if CONTROL_ENABLED:
        print(f"Control panel enabled at http://{lan_ip()}:5000/control")
    # debug=False, deliberately. The Werkzeug debugger is a remote shell on the
    # machine running the rig, and this listens on 0.0.0.0 so every device on the
    # network can reach it. Anything that trips an exception while the rig is in
    # use is a bug to read in the log, not one to hand a console to the lab.
    app.run(debug=False, host="0.0.0.0", threaded=True, use_reloader=False)
