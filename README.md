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

With server-side filtering on (`SERVER_FILTERING=1`, see below), the same
message gains one field; the existing fields do not change. `coordinate` is
`null` until the sensors are assigned and a reading arrives:

```json
{"type":"nodes:update","nodes":[...],"coordinate":{"status":"ok","x":25.0,"y":60.0,"gx":0,"gy":1,"rawGx":0,"rawGy":1,"column":0,"held":false,"heldFor":0,"calibrated":false,"raw":[60.0,null,null],"filtered":[60.0,null,null]}}
```

### Browser → Server (WebSocket)

`canvas.js` connects to `ws://<host>:8765/browser` and renders live node data on an HTML canvas. It can also send `menu:select` messages back to the server for UI interactions.

With server-side filtering on, the server also accepts (nothing sends these
yet; see step 2 below):

```json
{"type": "sensors:assign",     "slots": [2, 1, 3]}
{"type": "calibration:update", "perColumn": [{"near": 28.5, "far": 140.7}, ...]}
```

## Filtering pipeline (`Website/filterRules.py`)

The sensor filtering rules - slew gate, median, dropout hold, raw-reading
proximity alert, column selection, calibrated row mapping, cell majority vote
and hold-and-recovery - are ported from `public/displays/game.js` into a
standalone Python pipeline, so the filtered coordinate can be computed once on
the server instead of in every browser tab.

**It is wired into `app.py` behind a flag, off by default.** Start the server
with `SERVER_FILTERING=1` to run it; without the flag the server behaves
exactly as before. Either way the game still filters in `game.js`, which stays
the rule owner, until steps 2 (browser side) and 5-6 below are done.
`Website/serverFilter.py` is the adapter between node messages and the
pipeline.

`Website/tracking.py` is a per-sensor constant-velocity Kalman tracker for
path prediction (#18), tested in `Website/tests/test_tracking.py`; it is
**not wired** into the server or the browser yet.

The chain runs **once per new reading**. When one node reports, only its
channel gets a new sample; the other channels are marked not fresh and are
not fed their last reading again, which would fill their median windows with
repeats and add lag. The proximity guard still sees every channel's latest
raw reading.

```text
sample ──► Geometry ──► ProximityGuard (RAW) ──► ChannelFilter per channel
       ──► Geometry.locate ──► PlayArea row ──► CellStabiliser ──► HoldPolicy
       ──► FilteredCoordinate
```

| Class | Responsibility |
|---|---|
| `FilterConfig` | Every tunable, with defaults matching `game.js` |
| `PlayArea` | Calibrated bounds, alert threshold, row mapping with hysteresis |
| `ChannelFilter` | Slew gate → median → hold, for one channel in cm |
| `ProximityGuard` | Too-close on **raw** readings, confirmed over N frames |
| `Geometry` | Abstract: sensor data in, position out — the swappable part |
| `UltrasonicArrayGeometry` | Today's rig: three sensors, one column each |
| `CartesianGeometry` | A rig that reports `(x, y)` itself, e.g. the servo scanner |
| `CellStabiliser` | Majority vote over recent cells |
| `HoldPolicy` | Abstract: when to ride out bad readings |
| `StreakHold` / `MajorityWindowHold` | The two hold rules (see below) |
| `CoordinatePipeline` | Composes all of the above; one instance per player |

### Tests

```bash
python -m unittest discover -s Website/tests
```

Standard library only. `ParityWithGameJs` replays a reading stream that was
recorded by running the **real `game.js`** headless, and requires identical
output at every step, for both default and calibrated bounds. If you change a
filtering rule in `game.js` before integration, regenerate the recording:

```bash
node Website/tests/generate_parity_trace.js
```

### Integrating into `app.py`

Steps 1, 3, 4 and the server half of 2 are done (behind the flag); they are
kept here as the record of the design.

**1. Create one pipeline** at module level, next to the other shared state:

```python
from filterRules import CoordinatePipeline, UltrasonicArrayGeometry, PlayArea

pipeline = CoordinatePipeline(UltrasonicArrayGeometry())  # guard with state_lock
sensor_slots = [None, None, None]                         # node id per L, C, R
```

**2. Get the sensor order and calibration from the browser.** Both currently
live only in the browser: `calibrate.js` works out which node is left, centre
and right by hand-wave, and `callibrate_corners.js` captures the six play-area
points. Node IDs are assigned in TCP connection order and say nothing about
position, so the server cannot infer either. In `browser_handler()`, beside
the existing `menu:select` case, accept:

```json
{"type": "sensors:assign",     "slots": [2, 1, 3]}
{"type": "calibration:update", "perColumn": [{"near": 28.5, "far": 140.7}, ...]}
```

and apply them with `sensor_slots = event["slots"]` and
`pipeline.set_area(PlayArea.calibrated([(c["near"], c["far"]) for c in ...]))`.
Send both from `canvas.js` whenever assignment or calibration completes.

**3. Feed it RAW distances.** In `update_node()`, after `update_distance()`,
build the three-slot reading and update once per incoming node message:

```python
reading = [raw_distance(nodes.get(node_id)) for node_id in sensor_slots]
result = pipeline.update(reading, time.monotonic() * 1000.0)
```

where `raw_distance()` returns the payload's `distance`/`avg` as a float, and
`None` for a missing node or a negative value. (As built, `serverFilter.py`
also passes a `fresh` mask so only the reporting node's channel is fed; the
snippet above alone would re-feed the other nodes' last readings.) **Do not pass
`node["filtered_distance"]`** — that is already median- and FFT-smoothed, and
filtering it again would add lag and could hide the spikes the proximity alert
depends on.

**4. Broadcast the result.** Add it to the existing `nodes:update` payload, or
send its own message:

```python
json.dumps({"type": "coordinate:update", "coordinate": result.to_dict()})
```

**5. Switch the browser over.** In `canvas.js`, on `coordinate:update`, hand
the result to the game through one exported function, e.g.
`window.setServerCoordinate(message.coordinate)`. In `game.js`, that function
replaces what `updateSensorCursor()` computes today:

- store it as `gameState.sensor`, and drive the cursor from its `gx` / `gy`;
- in `renderCoordinateMap()`, pass it straight through —
  `map.update(c.x, c.y, c.held ? "held" : null, { gx: c.gx, gy: c.gy })`;
- raise the alert when `c.status === "too-close"`.

The map instance lives inside `game.js`'s module scope, which is why this goes
through a function rather than `canvas.js` touching the map directly.

**6. Delete the JS copy.** Remove the conditioning, column selection, vote and
hold logic from `game.js`, and `mapCoordinateFromSensor()`. Keeping both means
two sources of truth that will drift apart.

### Behaviour to decide before integrating

**Hold policy.** `game.js` on `main` uses a *consecutive* bad-reading streak,
and so does `StreakHold`, the default — the port preserves behaviour. That
rule has a known blind spot: a single good reading resets the streak, so an
intermittent fault that alternates good and bad never triggers the
out-of-bounds message. `MajorityWindowHold` instead releases once *most* of the
last N readings are bad. Choose one explicitly:

```python
pipeline = CoordinatePipeline(UltrasonicArrayGeometry(),
                              hold=MajorityWindowHold(FilterConfig()))
```

**Call rate.** `game.js` runs the filters on every render frame, re-reading the
same `node.latest` until a new message arrives, so its median window partly
fills with repeats of one reading. `CoordinatePipeline.update()` should be called
once per reading, which is the intended behaviour — expect slightly smoother
output after integration than the browser gives today.

### Supporting the scanning rig

`src/scanning.cpp` tracks the player with two sensors on a servo. Once it
reports a position, use the existing geometry:

```python
pipeline = CoordinatePipeline(CartesianGeometry())
result = pipeline.update((x_cm, y_cm), now_ms)
```

If it reports angle and distance instead, add a `Geometry` subclass that
converts them to `(x, y)` in `channels()` / `locate()`. Nothing downstream
needs to change, and the position map in `coordinateMap.js` already accepts
plain `(x, y)`.
