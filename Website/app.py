import asyncio
from collections import deque
import json
import socket
import threading
import time
from flask import Flask, jsonify, render_template
from websockets.asyncio.server import broadcast, serve

app = Flask(__name__, template_folder="template", static_folder="public", static_url_path="/static")

TCP_HOST = "0.0.0.0"
TCP_PORT = 3000
WS_HOST = "0.0.0.0"
WS_PORT = 8765
NODE_STALE_SECONDS = 5
RPS_WINDOW_SECONDS = 1
HANDSHAKE_READ_LIMIT = 64

state_lock = threading.Lock()
next_node_id = 1
nodes = {}
BROWSER_CONNECTIONS = set()
WS_LOOP = None


def snapshot_nodes():
    with state_lock:
        return [
            {
                "id": node["id"],
                "address": node["address"],
                "latest": node["latest"],
                "online": node["online"],
                "last_seen": node["last_seen"],
                "rps": node["rps"],
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
            "rps": 0.0,
        }
    schedule_broadcast_nodes()
    return node_id


def reuse_or_register_node(address, claimed_node_id):
    global next_node_id
    with state_lock:
        now = time.monotonic()
        if claimed_node_id is not None and claimed_node_id in nodes:
            node = nodes[claimed_node_id]
            node["address"] = f"{address[0]}:{address[1]}"
            node["online"] = True
            node["last_seen"] = now
            node["rps"] = 0.0
            node["samples"].clear()
            node_id = claimed_node_id
        else:
            node_id = next_node_id
            next_node_id += 1
            nodes[node_id] = {
                "id": node_id,
                "address": f"{address[0]}:{address[1]}",
                "device_id": None,
                "latest": None,
                "online": True,
                "last_seen": now,
                "samples": deque(),
                "rps": 0.0,
            }
    schedule_broadcast_nodes()
    return node_id


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
    schedule_broadcast_nodes()


def mark_node_offline(node_id):
    with state_lock:
        node = nodes.get(node_id)
        if node is None:
            return
        node["online"] = False
        node["rps"] = 0.0
        node["samples"].clear()
    schedule_broadcast_nodes()


def read_claimed_node_id(conn):
    buffer = bytearray()
    while len(buffer) < HANDSHAKE_READ_LIMIT:
        chunk = conn.recv(1)
        if not chunk:
            break
        if chunk == b"\n":
            break
        if chunk != b"\r":
            buffer.extend(chunk)

    try:
        claimed_node_id = int(buffer.decode("utf-8").strip())
    except ValueError:
        claimed_node_id = None

    if claimed_node_id is not None and claimed_node_id < 0:
        return None
    return claimed_node_id


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


def handle_node_connection(conn, address):
    node_id = None
    conn.settimeout(5)
    try:
        claimed_node_id = read_claimed_node_id(conn)
        conn.settimeout(None)
        node_id = reuse_or_register_node(address, claimed_node_id)
        action = "restored" if claimed_node_id == node_id else "assigned"
        print(f"ESP32 connected from {address}, {action} id {node_id}")
        conn.sendall(f"{node_id}\n".encode("utf-8"))
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
            "online": node["online"],
            "last_seen": node["last_seen"],
            "rps": node["rps"],
        })


if __name__ == '__main__':
    threading.Thread(target=lambda: asyncio.run(websocket_server()), daemon=True).start()
    threading.Thread(target=tcp_server, daemon=True).start()
    threading.Thread(target=cleanup_stale_nodes, daemon=True).start()
    app.run(debug=True, host="0.0.0.0", threaded=True, use_reloader=False)
