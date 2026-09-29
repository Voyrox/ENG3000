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

Each ESP32 is a servo scanner (`src/scanning.cpp`): two ultrasonic sensors side by side (left: trigger/echo on GPIO 5/18, right: GPIO 16/17) on a servo (GPIO 32) that turns towards whichever sensor sees the player. Nodes scan one at a time: the server hands out turns (`TURN` / `HALT`) so their pings never overlap. It connects to the laptop hotspot, opens a persistent TCP socket on port `3000`, receives a numeric node ID, and sends a JSON line after every scan step:

```json
{"nodeId":1,"mac":"14:08:08:AB:F6:20","avg":82.40,"left":81.90,"right":82.90,"angle":112,"scanState":0}
```

- `avg` is the node's distance to the player (cm): the mean of the ultrasonics reading inside the scan range, or the nearer real echo if neither is; `-1` when neither heard anything
- `left` / `right` are the two ultrasonics (cm), `-1` for no echo
- `angle` is the servo angle the pair was read at: 90 points straight out into the play area, larger turns towards screen-left
- `scanState` is `0` found (both readings agree), `1` half-found (one sees the player), `2` lost (sweeping)

The server sends control lines back: `SYNC <tick>`, `TURN` / `HALT`, `ROLE LEFT` / `ROLE RIGHT` once the game's calibration screen has identified the node (again whenever it reconnects), which sets that mount's servo limits, and `AIM 90` / `SCAN` while the calibration screen is open / after it closes. A node boots holding its servo at 90 and sweeps only once told `SCAN`; the server sends `AIM 90` or `SCAN` the moment a node connects, so one that reboots mid-calibration never moves.

**Calibration** is the game's sensor-assignment screen: both servos are held still at 90 degrees (`AIM 90`) for the whole screen - through both steps, LEFT then RIGHT - while the operator aims the nodes straight out into the play area by hand and identifies each node with a hand in front of it; each live-readings row shows the angle the node reports, amber if it is not 90; Start Game then lets the nodes scan again (`SCAN`). There is no play-area (corner) calibration: the game plays on the default bounds, rows between 20 and 140 cm in every column. Each game page asks for the hold with `{"type": "nodes:aim", "hold": true}` and releases it with `false`; the servos stay held while any open page is on the calibration screen, so another tab or device on a different screen cannot release them, and a page that closes stops holding.

The game puts each node on the screen edge at the centre of an outer column and turns its distance and angle into a position; with both nodes in bounds the two positions are averaged. A node that sends no `angle` is treated as pointing straight out, and two such nodes are placed by trilateration.

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
message gains two fields; the existing fields do not change. `coordinate` is
`null` until the sensors are assigned and a reading arrives. `predicted_cm`
is each channel's predicted distance in cm (left, centre, right; see
path prediction below), `null` for a channel with no live track:

```json
{"type":"nodes:update","nodes":[...],"coordinate":{"status":"ok","x":25.0,"y":60.0,"gx":0,"gy":1,"rawGx":0,"rawGy":1,"column":0,"held":false,"heldFor":0,"calibrated":false,"raw":[60.0,null,null],"filtered":[60.0,null,null]},"predicted_cm":[60.4,null,null]}
```

With the flag off neither field is present.

### Browser → Server (WebSocket)

`canvas.js` connects to `ws://<host>:8765/browser` and renders live node data on an HTML canvas. It can also send `menu:select` messages back to the server for UI interactions.

With server-side filtering on, the server also accepts:

```json
{"type": "sensors:assign",     "slots": [2, 1, 3]}
{"type": "calibration:update", "perColumn": [{"near": 28.5, "far": 140.7}, ...]}
```

`sensors:assign` is sent whatever the flag (the server passes each node its
role), once the hand-wave assignment is complete. `calibration:update` is only
sent when the server reports the flag on (the `coordinate` field in
`nodes:update`) and a corner calibration has been captured - which no screen
does any more, so the server keeps its default bounds. Each is sent again
only if it changes or the socket reconnects, because `sensors:assign` resets
the server's filters. `perColumn` is sent as captured; the server applies the
same shallow-column fallback as `getBounds()`.

## Filtering pipeline (`Website/filterRules.py`)

The sensor filtering rules - slew gate, median, dropout hold, raw-reading
proximity alert, column selection, calibrated row mapping, cell majority vote
and hold-and-recovery - are ported from `public/displays/game.js` into a
standalone Python pipeline, so the filtered coordinate can be computed once on
the server instead of in every browser tab.

**It is wired into `app.py` behind a flag, off by default.** Start the server
with `SERVER_FILTERING=1` to run it; without the flag the server and the
browser behave exactly as before and the game filters in `game.js`. With the
flag on, the game's cursor and too-close alert come from the server's
`coordinate` instead. `game.js` still holds the JS copy of the rules and stays
the rule owner until step 6 below.
`Website/serverFilter.py` is the adapter between node messages and the
pipeline.

**Path prediction (#18).** `Website/tracking.py` is a per-sensor
constant-velocity Kalman tracker (distance and velocity). With the flag on,
`serverFilter.py` keeps one tracker per channel, feeds it the same fresh raw
reading that channel's filter gets, and publishes every channel's predicted
distance as `predicted_cm` in `nodes:update`, brought forward to the time of
the latest reading. It is **published only**: the coordinate, the cell vote
and the proximity alert do not read it, the median stays the rule owner, and
the browser does not use it yet. Replacing the median with the tracker would
first need the model's NIS spike gate ported. Tunables, all named constants
in `tracking.py` / `serverFilter.py`: process noise 400 cm/s², measurement
noise 0.91 cm, track dropped after 0.5 s without a reading (or when its node
goes offline), extrapolation capped at 250 ms, extra display lead 0 s until
the end-to-end latency is measured. Tests are in
`Website/tests/test_tracking.py` and `Website/tests/test_serverFilter.py`.

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
| `TwoSensorGeometry` | Today's rig: LEFT and RIGHT sensors, placed by basic trilateration |
| `UltrasonicArrayGeometry` | The earlier three-sensor rig, one column each (replays V1 logs) |
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

`test_app.py` covers the broker and coordinator in `app.py`: the FFT filter,
node identity and MAC de-duplication, the ESP32 handshake, the median/FFT
reading pipeline, the stale-node reaper, the HTTP and `/browser` endpoints, and
the scan-turn arbitration. The sockets are faked and the `while True` workers
are stepped by stubbing `time.sleep`, so it binds no port and finishes in about
a tenth of a second.

### Integrating into `app.py`

Steps 1-5 are done, behind the flag; they are kept here as the record of the
design. Step 6 waits until the team drops the flag, since the flag-off path
still needs the JS copy.

**1. Create one pipeline** at module level, next to the other shared state:

```python
from filterRules import CoordinatePipeline, UltrasonicArrayGeometry, PlayArea

pipeline = CoordinatePipeline(UltrasonicArrayGeometry())  # guard with state_lock
sensor_slots = [None, None, None]                         # node id per L, C, R
```

**2. Get the sensor order and calibration from the browser.** Both currently
live only in the browser: `calibrate.js` works out which node is left, centre
and right by hand-wave, and `callibrate_corners.js` holds the play-area
bounds (captured corners once; now the defaults). Node IDs are assigned in TCP connection order and say nothing about
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
`window.setServerCoordinate(message.coordinate)`. (As built, the coordinate
rides on `nodes:update`, and `window.setServerFilteringActive()` switches
`game.js` between its own filters and the server's result. With the flag on,
the cursor is also cleared once every assigned node is offline or the socket
closes, because the server only recomputes on a new reading.) In `game.js`, that function
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
