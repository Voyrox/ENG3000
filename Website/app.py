import json
import socket
import threading
from flask import Flask, Response, jsonify, render_template

app = Flask(__name__, template_folder="template", static_folder="public", static_url_path="/static")

TCP_HOST = "0.0.0.0"
TCP_PORT = 3000

state_lock = threading.Lock()
state_condition = threading.Condition(state_lock)
next_node_id = 1
nodes = {}


def register_node(address):
    global next_node_id
    with state_lock:
        node_id = next_node_id
        next_node_id += 1
        nodes[node_id] = {
            "id": node_id,
            "address": f"{address[0]}:{address[1]}",
            "latest": None,
            "online": True,
        }
        return node_id


def update_node(node_id, message):
    with state_condition:
        node = nodes.get(node_id)
        if node is None:
            return
        node["latest"] = message
        state_condition.notify_all()


def handle_node_connection(conn, address):
    node_id = register_node(address)
    print(f"ESP32 connected from {address}, assigned id {node_id}")
    try:
        conn.sendall(f"{node_id}\n".encode("utf-8"))
        with conn.makefile("r") as stream:
            for line in stream:
                message = line.strip()
                if not message:
                    continue
                print(f"Node {node_id}: {message}")
                update_node(node_id, message)
    except OSError as exc:
        print(f"Node {node_id} disconnected: {exc}")
    finally:
        with state_condition:
            if node_id in nodes:
                nodes[node_id]["online"] = False
                state_condition.notify_all()
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


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/api/nodes")
def api_nodes():
    with state_lock:
        return jsonify(list(nodes.values()))


@app.route("/api/nodes/<int:node_id>")
def api_node(node_id):
    with state_lock:
        node = nodes.get(node_id)
        if node is None:
            return jsonify({"error": "unknown node"}), 404
        return jsonify(node)


@app.route("/stream")
def stream():
    def event_stream():
        last_snapshot = None
        while True:
            with state_condition:
                state_condition.wait(timeout=2)
                snapshot = json.dumps(list(nodes.values()))
            if snapshot != last_snapshot:
                last_snapshot = snapshot
                yield f"data: {snapshot}\n\n"
            else:
                yield ": keepalive\n\n"

    return Response(event_stream(), mimetype="text/event-stream")


if __name__ == '__main__':
    threading.Thread(target=tcp_server, daemon=True).start()
    app.run(debug=True, host="0.0.0.0", threaded=True, use_reloader=False)
