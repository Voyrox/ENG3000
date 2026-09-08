import asyncio
from collections import deque
import json
import socket
import threading
import time
from flask import Flask, jsonify, render_template
from websockets.asyncio.server import broadcast, serve
import numpy as np

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

state_lock = threading.Lock()
next_node_id = 1
nodes = {}
sync_tick = 0
BROWSER_CONNECTIONS = set()
WS_LOOP = None


def snapshot_nodes():
    with state_lock:
        return [
            {
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
            for node in nodes.values()
        ]


async def broadcast_nodes():
    message = json.dumps({"type": "nodes:update", "nodes": snapshot_nodes()})
    if BROWSER_CONNECTIONS:
        broadcast(BROWSER_CONNECTIONS.copy(), message)


def schedule_broadcast_nodes():
    if WS_LOOP is not None and WS_LOOP.is_running():
        asyncio.run_coroutine_threadsafe(broadcast_nodes(), WS_LOOP)


def register_node(address):
    global next_node_id
    with state_lock:
        node_id = next_node_id
        next_node_id += 1
        nodes[node_id] = {
            "id": node_id,
            "address": f"{address[0]}:{address[1]}",
            "device_id": None,
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
    schedule_broadcast_nodes()
    return node_id


def reuse_or_register_node(address, claimed_node_id, device_id=None):
    global next_node_id
    with state_lock:
        now = time.monotonic()
        node = None
        reused_existing = False

        if device_id:
            for existing in nodes.values():
                if existing.get("device_id") == device_id:
                    node = existing
                    break

        if node is None and claimed_node_id is not None and claimed_node_id in nodes:
            node = nodes[claimed_node_id]

        if node is not None:
            reused_existing = True
            node["address"] = f"{address[0]}:{address[1]}"
            node["online"] = True
            node["last_seen"] = now
            node["rps"] = 0.0
            node["samples"].clear()
            node["median_samples"].clear()
            node["distance_samples"].clear()
            node["filtered_distance"] = None
            node["synced"] = False
            node["has_turn"] = False
            node["conn"] = None
            if device_id:
                node["device_id"] = device_id
            node_id = node["id"]
        else:
            node_id = next_node_id
            next_node_id += 1
            nodes[node_id] = {
                "id": node_id,
                "address": f"{address[0]}:{address[1]}",
                "device_id": device_id,
                "latest": None,
                "online": True,
                "last_seen": now,
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
    schedule_broadcast_nodes()
    return node_id, reused_existing


def update_node(node_id, message):
    with state_lock:
        node = nodes.get(node_id)
        if node is None:
            return
        now = time.monotonic()
        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            payload = {}

        device_id = payload.get("mac")
        if device_id:
            for other_id, other in list(nodes.items()):
                if other_id != node_id and other.get("device_id") == device_id:
                    del nodes[other_id]
            node["device_id"] = device_id

        node["latest"] = message
        node["online"] = True
        node["last_seen"] = now
        samples = node["samples"]
        samples.append(now)
        cutoff = now - RPS_WINDOW_SECONDS
        while samples and samples[0] < cutoff:
            samples.popleft()
        node["rps"] = float(len(samples)) / float(RPS_WINDOW_SECONDS)

        distance = payload.get("distance")
        if distance is None:
            distance = payload.get("avg")
        if distance is not None:
            try:
                distance = float(distance)
            except (TypeError, ValueError):
                distance = None
        if distance is not None:
            medians = node["median_samples"]
            medians.append(distance)
            smoothed = float(np.median(medians))
            history = node["distance_samples"]
            history.append(smoothed)
            if len(history) >= FFT_MIN_SAMPLES:
                filtered = fft_filter_ultrasonic(
                    history,
                    DISTANCE_SAMPLE_RATE_HZ,
                    DISTANCE_CUTOFF_HZ,
                )
                node["filtered_distance"] = float(filtered[-1])
            else:
                node["filtered_distance"] = smoothed
    schedule_broadcast_nodes()


def mark_node_offline(node_id):
    with state_lock:
        node = nodes.get(node_id)
        if node is None:
            return
        node["online"] = False
        node["rps"] = 0.0
        node["samples"].clear()
        node["synced"] = False
        node["has_turn"] = False
        node["conn"] = None
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
        try:
            payload = json.loads(raw_line)
        except json.JSONDecodeError:
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
                    stale_ids.append(node_id)

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


def sync_node(node_id):
    """Send the authoritative tick to one node (PC is source of truth)."""
    with state_lock:
        tick = sync_tick
        node = nodes.get(node_id)
        if node is None:
            return
        node["synced"] = True
    send_command(node_id, f"SYNC {tick}")


def grant_turn(node_id):
    """Grant a scan slot to a node; no other node may scan at the same time."""
    send_command(node_id, "TURN")
    with state_lock:
        node = nodes.get(node_id)
        if node is not None:
            node["has_turn"] = True
    schedule_broadcast_nodes()


def revoke_turn(node_id):
    """Take the scan slot away from a node until the next grant."""
    send_command(node_id, "HALT")
    with state_lock:
        node = nodes.get(node_id)
        if node is not None:
            node["has_turn"] = False
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
            online_ids = sorted(
                node_id for node_id, node in nodes.items()
                if node.get("online") and node.get("conn") is not None
            )
        if not online_ids:
            continue

        # One tick of authority for every node, then the next node scans.
        for node_id in online_ids:
            sync_node(node_id)

        active = online_ids[sync_tick % len(online_ids)]
        for node_id in online_ids:
            if node_id == active:
                grant_turn(node_id)
            else:
                revoke_turn(node_id)

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
        node_id, reused_existing = reuse_or_register_node(address, claimed_node_id, device_id)
        action = "restored" if reused_existing else "assigned"
        print(f"ESP32 connected from {address}, {action} id {node_id}")
        conn.sendall(f"{node_id}\n".encode("utf-8"))
        with state_lock:
            node = nodes.get(node_id)
            if node is not None:
                node["conn"] = conn
                node["synced"] = False
                node["has_turn"] = False
        if first_message is not None:
            update_node(node_id, first_message)
        with conn.makefile("r") as stream:
            for line in stream:
                message = line.strip()
                if not message:
                    continue
                #print(f"Node {node_id}: {message}")
                update_node(node_id, message)
    except (OSError, TimeoutError) as exc:
        print(f"Node {node_id if node_id is not None else 'unknown'} disconnected: {exc}")
    finally:
        if node_id is not None:
            mark_node_offline(node_id)
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


async def browser_handler(websocket):
    BROWSER_CONNECTIONS.add(websocket)
    try:
        await websocket.send(json.dumps({"type": "nodes:update", "nodes": snapshot_nodes()}))
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
    finally:
        BROWSER_CONNECTIONS.discard(websocket)


async def websocket_handler(websocket):
    match websocket.request.path:
        case "/browser":
            await browser_handler(websocket)
        case _:
            await websocket.close()


async def websocket_server():
    global WS_LOOP
    WS_LOOP = asyncio.get_running_loop()
    async with serve(websocket_handler, WS_HOST, WS_PORT, ping_interval=2, ping_timeout=2):
        print(f"WebSocket server listening on {WS_HOST}:{WS_PORT}")
        await asyncio.Future()


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/api/nodes")
def api_nodes():
    return jsonify(snapshot_nodes())


@app.route("/api/nodes/<int:node_id>")
def api_node(node_id):
    with state_lock:
        node = nodes.get(node_id)
        if node is None:
            return jsonify({"error": "unknown node"}), 404
        return jsonify({
            "id": node["id"],
            "address": node["address"],
            "latest": node["latest"],
            "filtered_distance": node["filtered_distance"],
            "online": node["online"],
            "last_seen": node["last_seen"],
            "rps": node["rps"],
            "synced": node["synced"],
            "has_turn": node["has_turn"],
        })


if __name__ == '__main__':
    threading.Thread(target=lambda: asyncio.run(websocket_server()), daemon=True).start()
    threading.Thread(target=tcp_server, daemon=True).start()
    threading.Thread(target=cleanup_stale_nodes, daemon=True).start()
    threading.Thread(target=coordinator_loop, daemon=True).start()
    app.run(debug=True, host="0.0.0.0", threaded=True, use_reloader=False)
