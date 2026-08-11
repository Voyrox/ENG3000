# ENGG3000 Group 1

ESP32 ultrasonic sensor nodes that detect boats and report readings to a web dashboard.

## Architecture

```
ESP32 ── Wi-Fi ──▶ gateway/server ── TCP :3000 ──▶ Python Server
                                      └── WebSocket:8765 ──▶ Browser
                                    │
                                    └── REST:5000 ──▶ /api/nodes
```

### ESP32 → Server (TCP)

Each ESP32 connects to the laptop hotspot and uses the Wi-Fi gateway address as the server address. It opens a persistent TCP socket on port `3000`, receives a numeric node ID, and sends a JSON line on every `loop()` cycle:

```json
{"nodeId":1,"avg":12.34,"detected":false}
```

- `avg` is the rolling average of the last 3 ultrasonic distance readings (cm)
- `detected` — `true` when `avg <= safeDistance` (50 cm)

### Python Server (Flask + WebSockets)

`app.py` runs three concurrent services:

| Service | Port | Role |
|---------|------|------|
| TCP broker | 3000 | Accepts ESP32 connections, assigns node IDs, reads sensor lines |
| WebSocket | 8765 | Pushes `nodes:update` messages to browser clients |
| Flask (REST) | 5000 | Serves the web UI and `/api/nodes` endpoint |

When the TCP broker receives a sensor reading, it updates the node's state and broadcasts to all connected browsers via WebSocket:

```json
{"type":"nodes:update","nodes":[{"id":1,"address":"192.168.1.42:12345","latest":"{...}","online":true,"rps":2.0}]}
```

Nodes that haven't reported in 5 seconds are marked stale and removed.

### Browser → Server (WebSocket)

`canvas.js` connects to `ws://<host>:8765/browser` and renders live node data on an HTML canvas. It can also send `menu:select` messages back to the server for UI interactions.
