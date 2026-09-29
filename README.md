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

Each ESP32 is a servo scanner (`src/Scanner.cpp`; every pin and setting is in `src/Config.h`): two ultrasonic sensors side by side (left: trigger/echo on GPIO 5/18, right: GPIO 16/17) on a servo (GPIO 32) that turns towards whichever sensor sees the player. Nodes scan one at a time: the server hands out 0.4 s turns (`TURN` / `HALT`), and HALTs one node 40 ms before it grants the next its TURN, so their pings never overlap. It connects to the laptop hotspot, opens a persistent TCP socket on port `3000`, receives a numeric node ID, and sends a JSON line after every scan step:

```json
{"nodeId":1,"mac":"14:08:08:AB:F6:20","avg":82.40,"left":81.90,"right":82.90,"angle":112,"scanState":0}
```

- `avg` is the node's distance to the player (cm): the mean of the ultrasonics reading inside the scan range, or the nearer real echo if neither is; `-1` when neither heard anything
- `left` / `right` are the two ultrasonics (cm), `-1` for no echo
- `angle` is the servo angle the pair was read at: 90 points straight out into the play area, larger turns towards screen-left
- `scanState` is `0` found (both readings agree), `1` half-found (one sees the player), `2` lost (sweeping)

A reading between `MIN_TARGET_CM` and `MAX_TARGET_CM` (10-180 cm) is the player. The node listens for echoes out to `MAX_TARGET_CM` + 40 cm: `ECHO_TIMEOUT_US` is worked out from `MAX_TARGET_CM`, so raising the range in `Config.h` really does let a node see further. When a node loses the player it stays put for two pairs (`LOST_GRACE_PAIRS`: at the back of the play area one pair often misses a player who has not moved), then looks 10, 20 and 30° either side of where it last saw them, first on the side it was steering towards (`LOCAL_SEARCH_STEP_DEG`, `LOCAL_SEARCH_SPAN_DEG`), and only then sweeps the whole range 14° at a time.

The server sends control lines back: `SYNC <tick>`, `TURN` / `HALT`, `ROLE LEFT` / `ROLE RIGHT` once the game's calibration screen has identified the node (again whenever it reconnects), which sets that mount's servo limits, and `AIM 90` / `SCAN` while the calibration screen is open / after it closes, and `PULSES <n>` (multi-pulse, below). A node boots holding its servo at 90 and sweeps only once told `SCAN`; the server sends `AIM 90` or `SCAN` the moment a node connects, so one that reboots mid-calibration never moves.

**Multi-pulse** is the `PULSES <n>` command: in found or half-found, the node takes `n` pulse pairs at one angle (1 = off, the default; at most 5), averages each sensor's readings with outliers left out, and only then reports one reading and moves. A lost pair still sweeps straight away. "Outliers" means: pulses with no echo are skipped, echoes outside the play area are skipped if any pulse saw the player inside it, then an echo more than `OUTLIER_TOLERANCE_CM` (20 cm) from the median is dropped (for two echoes that disagree, the nearer one is kept), and the rest are averaged. It is switched with the **Pulses** button on the game screen (top right: Off, 2, 3), which sends `{"type": "nodes:pulses", "count": 3}`; the server passes the count on to every node, and again to each node as it connects. With multi-pulse on, a node reports about once every `n` pairs while it has the player, instead of after every pair.

#### Firmware layout (`src/`)

| File | What it is |
|------|------------|
| `Config.h` | Every pin, range, timing, step size, servo limit, network setting and multi-pulse setting |
| `main.cpp` | Creates the objects below; `setup()` and `loop()` |
| `UltrasonicSensor.h/.cpp` | `UltrasonicSensor`: one sensor, a distance in cm or `-1` for no echo |
| `ScannerServo.h/.cpp` | `ScannerServo`: the servo angle, per-role limits (`NodeRole`), the calibration hold and settle time |
| `Scanner.h/.cpp` | `Scanner`: the found / half-found / lost state machine and multi-pulse; `ScanReading`, `ScanState` |
| `NodeConnection.h/.cpp` | `NodeConnection`: Wi-Fi, the TCP socket, the handshake and node id, sending and reading lines |
| `ServerDiscovery.h/.cpp` | Finds the server on the local subnet (only with `AUTO_DISCOVER_SERVER`) |
| `CommandHandler.h/.cpp` | `CommandHandler`: carries out the server's control lines |
| `Telemetry.h/.cpp` | The JSON line above |

The Wi-Fi network and server IP default to the values in `Config.h`. To use your own without committing them, add them to your own (gitignored) `platformio.ini`:

```ini
build_flags =
    '-DNODE_WIFI_SSID="MyHotspot"'
    '-DNODE_WIFI_PASSWORD="secret"'
    '-DNODE_SERVER_IP="192.168.137.1"'
```

**Calibration** is the game's sensor-assignment screen: both servos are held still at 90 degrees (`AIM 90`) for the whole screen - through both steps, LEFT then RIGHT - while the operator aims the nodes straight out into the play area by hand and identifies each node with a hand in front of it; each live-readings row shows the angle the node reports, amber if it is not 90; Start Game then lets the nodes scan again (`SCAN`). There is no play-area (corner) calibration: the game plays on the default bounds, rows between 20 and 140 cm in every column. Each game page asks for the hold with `{"type": "nodes:aim", "hold": true}` and releases it with `false`; the servos stay held while any open page is on the calibration screen, so another tab or device on a different screen cannot release them, and a page that closes stops holding.

The game puts each node on the screen edge at the centre of an outer column. In sensor mode, four buttons above the sensor panel pick how the player is placed - **Nearest** (the nearest node, the default), **Sightline** (line of sight), **Trilaterate** or **Average** - and **Compare** draws all four on the board as labelled rings (NEAR, LOS, TRI, AVG) while the big cursor follows the chosen one; the sensor panel lists all four positions. See *Placing the player* under the filtering pipeline. With no `angle` from either node there is no line of sight and no aim, and every method is trilateration.

The board is drawn with the row **nearest the screen at the top**, so stepping towards the screen moves the cursor up. Only the drawing is flipped (`boardRow()` in `game.js`, one switch, `NEAR_ROW_AT_TOP`): grid row `gy = 0` is still the row nearest the screen everywhere else, and left/right is unchanged. The phone control panel's touchpad maps onto the board as drawn.

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

`canvas.js` connects to `ws://<host>:8765/browser` and renders live node data on an HTML canvas. It can also send `menu:select` messages back to the server for UI interactions, `nodes:aim` from the calibration screen (above), and `{"type": "nodes:pulses", "count": 1|2|3}` from the game screen's Pulses button (multi-pulse, above; sent when it changes and after a reconnect; any other count is ignored).

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

The sensor filtering rules - slew gate, median, Kalman, FFT low-pass, dropout
hold, raw-reading proximity alert, column selection, calibrated row mapping, cell majority vote
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
the latest reading. The predictions are **published only**: the coordinate,
the cell vote and the proximity alert do not read them, and the browser does
not use them yet. (The same tracker class is also the Kalman stage of every
channel's filter - see *Channel smoothing* below - where it runs on the
median's output rather than replacing it.) Tunables, all named constants
in `tracking.py` / `serverFilter.py`: process noise 400 cm/s², measurement
noise 0.91 cm, track dropped after 0.5 s without a reading (or when its node
goes offline), extrapolation capped at 250 ms, extra display lead 0 s until
the end-to-end latency is measured. Tests are in
`Website/tests/test_tracking.py` and `Website/tests/test_serverFilter.py`.

### Placing the player: nearest node, line of sight, trilateration, average

The nodes scan one at a time (the server hands out 0.4 s turns), so the two
are never read at the same moment, and a node that has lost the player keeps
reporting whatever its beam hits while it sweeps. The position methods
(`solvePositions()` in `game.js`, `TwoSensorGeometry(method=...)` here):

- **Nearest node** (`near`, the default; `nearestNodeFix()` in the game,
  `TwoSensorGeometry._nearest()` here). The node nearer the player is the
  main source: its servo angle and distance place them. When both nodes see
  the player, their two distances are trilaterated instead, which is more
  exact: a distance is good to a centimetre or two, a servo angle only to
  within the beam (about 15°, which is 40 cm sideways at 150 cm).
  - Each node's *sighting* is its last new reading that saw the player (a
    distance, not lost). It is kept through a missed echo and the other
    node's turn, until it is 1.5 s old (`nearMaxAgeMs`).
  - The two sightings are trilaterated only when they were taken at most
    500 ms apart (`triMaxGapMs`), the circles cross inside the play area, and
    the crossing is within 20° of where each servo pointed (`triBearingDeg`).
    The last check is what stops a node locked onto a chair being crossed
    with a node on the player.
  - Otherwise the nearer node that still sees the player (its latest reading
    is not lost) places them on its own, one whose point is inside the play
    area first. With neither, there is no position and the hold rides it out.
- **Line of sight** (`los`). Each node's reading is a point along
  its line of sight - its distance along its servo angle - with an
  uncertainty that is small along the line (3 cm) and grows across it with
  the distance and with how sure the node is of its aim: 4° when both of its
  sensors see the player (found), 15° when one does (half-found). Those feed a
  2D constant-velocity Kalman filter (`LineOfSightTracker`, `losTrack` in the
  game), one reading at a time as it arrives:
  - a node's reading is used once, when it is new - never again while the
    other node takes its turn;
  - a node that is sweeping (lost) is left out;
  - its aim counts in full only when it is new (the servo moved, or the node
    has just started its turn); while the servo holds still each further
    reading's aim counts less (the k-th repeat 1/(k+1)², about one and a half
    readings' worth in all), so the same small aim error is not counted again
    and again, and the two nodes' distances - counted in full every time -
    pin the player down;
  - a reading far from where the track expects the player is left out
    (a 99.9 % gate), and six of those in a row restart the track there;
  - after 1.5 s with nothing usable there is no position.
- **Trilateration** (`tri`), the earlier method, kept to compare against:
  where the two distance circles cross, using each node's latest distance
  however old, and whatever that node was looking at. It also checks each
  distance against the play area's *depth*, so a long diagonal to a far
  corner (over 155 cm) is refused and the nearer node is used alone.
- **Average** (`avg`): the midpoint of line of sight and trilateration.

The phone control panel (`/control`, server started with `CON=1`) has the
same switch under *Placing the player*, and shows which method is in use; its
buttons come from the game's status, so a new method appears there by itself.
In the browser console, `tuneSensor({ nearMaxAgeMs, triMaxGapMs,
triBearingDeg, losAccelCmS2, losBearingFoundDeg, losBearingHalfDeg })`
changes them live; `setPositionMethod("los")` switches method. The Python
side takes the same through `FilterConfig` (`near_*`, `tri_*`, `los_*`), and
with `SERVER_FILTERING` on the switch is sent to the server
(`{"type": "position:method", "method": "near"}`).

In simulation - the real `game.js`, two scanner nodes taking turns, servos
stepping 3° and sweeping when they lose the player, 15° beams, 2 cm distance
noise, a player walking the board and pausing - over three seeds:

| Method | 1 s turns: median | 90th pct | Right cell | 0.4 s turns: median | 90th pct | Right cell |
|---|---|---|---|---|---|---|
| Nearest node | 5.0 cm | 22.8 cm | 61 % | 2.4 cm | 16.6 cm | 66 % |
| Line of sight | 6.3 cm | 16.7 cm | 65 % | 4.2 cm | 13.0 cm | 68 % |
| Trilateration | 2.3 cm | 26.2 cm | 63 % | 2.4 cm | 18.9 cm | 65 % |
| Average | 3.5 cm | 20.3 cm | 66 % | 2.9 cm | 15.6 cm | 67 % |

(Main at 247006b, which averaged the two nodes' angle-and-distance points,
scored 7.0 cm, 24.7 cm and 58 % with 1 s turns.) Shorter turns help every
method that uses distances, because the other node's distance is at most a
turn old: with 1 s turns a walking player had moved up to 60 cm in between.
The nearest node is the most exact most of the time (the median); line of
sight makes the fewest large errors (the 90th percentile). With both nodes
read at once, all four are within 2 cm (median). Furniture inside the play
area fools every method: a scanner "finds" it exactly as it finds a player.
Check the real rig with Compare.

Reproduce it with `node Website/tools/simulate_positions.js` (options:
`--turn-ms 1000,400,0` - 0 is both nodes at once - `--furniture 140,125`,
`--seeds`, `--methods near,los,tri,avg`, `--tune '{"triMaxGapMs":800}'`, and
`--site` to score another copy of `public/`; the far-end options are below).

Each channel also starts again when its node comes back after a silence
longer than the hold (350 ms) - the other node's turn, as a rule - so the
median and the gate do not hold the new readings back with where the player
was a turn ago.

### Why the back of the play area failed (29 Sep)

With the nodes 50 cm out from the wall, the brief's play area (0.6-2.0 m from
the wall) runs 10-150 cm deep from the nodes, and a node is up to 195 cm from
the far corner on the other side. Four things lost the player out there:

1. **The echo timeout cut the range to about 145 cm.** `ECHO_TIMEOUT_US` was a
   fixed 9000 us, sized for a 140 cm range, and `pulseIn()` counts it from the
   trigger, so no echo from further than about 145 cm ever came back. The back
   row and every long diagonal read as no echo, and raising `MAX_TARGET_CM` to
   180 on its own changed nothing. It is now worked out from `MAX_TARGET_CM`
   (13.9 ms, echoes to 220 cm).
2. **One missed echo swung the servo away.** A lost pair swept 14° straight
   away, and at range a person's echo is weak, so a single miss took the
   node off a player who had not moved, for a whole sweep. Now it stays put
   for two pairs, then searches around where it last saw them (above).
3. **1 s turns.** The other node's reading was up to a second old, so any
   method that pairs the two distances was pairing where the player is with
   where they were. Now 0.4 s, with the HALT 40 ms ahead of the next TURN.
4. **One miss threw a node out of the pairing.** The nearest-node method keeps
   each node's last sighting through a missed echo, so one miss no longer
   drops it to one node's coarse angle for the rest of the other node's turn.

`node Website/tools/simulate_positions.js --tour deep --target-cm 180 --miss 0.3
--range-cm 145` (and `--range-cm 220 --firmware search`) scores it: a tour
that stands in the back row (130-145 cm deep), with a pair missing the player
30 % of the time at 150 cm (a guess: measure it on the rig with the sensor
recorder, `REC=1`). Nearest node / line of sight:

| Firmware and turns | Median error | 90th percentile | Right cell | Placed |
|---|---|---|---|---|
| Before: echoes to 145 cm, sweep on a miss, 1 s turns | 17.0 / 15.8 cm | 56.6 / 56.8 cm | 37 / 47 % | 90 / 94 % |
| Echoes to 220 cm | 11.7 / 11.0 cm | 35.9 / 28.4 cm | 59 / 69 % | 100 / 100 % |
| + search when lost | 9.7 / 9.8 cm | 29.5 / 20.7 cm | 69 / 70 % | 100 / 100 % |
| + 0.4 s turns | 3.0 / 5.9 cm | 18.7 / 14.4 cm | 70 / 72 % | 100 / 100 % |

"Placed" is the share of the time the game had a position at all. Still to
check on the rig: `MAX_TARGET_CM` (180) must stay short of anything behind or
beside the play area, or a scanner will lock onto it as if it were a player;
and the miss rate at 150-195 cm, which the table above only guesses.

### Channel smoothing: median → Kalman → FFT

Every sensor channel, in the game (`conditionSensor()` in `game.js`) and in
its Python copy (`ChannelFilter`), runs the five steps below. Each node's
`filtered_distance` in `app.py` runs steps 2-4 only - median, Kalman, FFT, no
gate and no hold - and is published in `nodes:update` and `/api/nodes`;
nothing in the game reads it.

1. **Slew gate** - a jump no person could make is dropped (unchanged).
2. **Median** of the last 5 readings - kills single-reading spikes.
3. **Kalman** - constant-velocity (`tracking.ConstantVelocityTracker`; the
   game has a line-for-line port, `kalmanUpdate()`): process noise
   400 cm/s², measurement noise 0.91 cm. Its velocity state follows a walking
   player without the lag an average adds.
4. **FFT low-pass** over the last 32 Kalman outputs, cut above 3 Hz, read
   back at the newest reading. The sample rate is measured from the window's
   own timestamps: a node sends about 11-12 readings a second while it has its
   turn, fewer with multi-pulse on, and a window never spans the other node's
   turn (the channel starts again after a silence). The window's
   straight-line trend is taken out first and added back after, and the rest
   is mirrored at the newest end. Without that, the FFT treats the window as
   a loop: the old version (mean removed only, 64 readings, 2 Hz) put a
   player walking at 50 cm/s about 35 cm behind where they were.
5. **Hold** - coasts 350 ms through a dropped echo (unchanged); after that, or
   after a re-lock, the median, Kalman and FFT window all start again.

In simulation (40 noise seeds, 2 cm reading noise, 20 Hz) the chain is within
a few hundredths of a centimetre of the median alone on a standing player and
adds no lag to a steady walk; after a quick step it settles in about 0.16 s,
against 0.11 s for the median alone. The FFT stage is the part to judge on the
rig. In the browser console, `tuneSensor({ fftWindow: 0 })` turns it off and
`tuneSensor({ fftCutoffHz: 2 })` / `tuneSensor({ kalmanSigmaA: 200 })` change
it, from the next reading; the Python side takes the same settings through
`FilterConfig` (`fft_window`, `fft_cutoff_hz`, `kalman_sigma_a_cm_s2`, ...).
The game steps a node's filters only on that node's new readings, not on
every animation frame. On the server a no-echo reading (negative) is skipped
rather than put into the median, and the median takes the upper of the two
middle values, as the game's does.

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
| `ChannelFilter` | Slew gate → median → Kalman → FFT low-pass → hold, for one channel in cm |
| `ProximityGuard` | Too-close on **raw** readings, confirmed over N frames |
| `Geometry` | Abstract: sensor data in, position out — the swappable part |
| `TwoSensorGeometry` | Today's rig: LEFT and RIGHT scanners, placed by the nearest node (trilaterating when both see the player), line of sight (`LineOfSightTracker`), trilateration or the average of the last two |
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
node identity and MAC de-duplication, the ESP32 handshake, the median/Kalman/FFT
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
`node["filtered_distance"]`** — that is already median-, Kalman- and FFT-smoothed, and
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
- raise the alert when `c.status === "too-close"`.

The game state lives inside `game.js`'s module scope, which is why this goes
through a function rather than `canvas.js` touching it directly.

**6. Delete the JS copy.** Remove the conditioning, column selection, vote and
hold logic from `game.js`. Keeping both means two sources of truth that will
drift apart.

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

**Call rate.** `game.js` steps a node's filters only when that node's reading
is new (its server stamp, `last_seen`, changed), which is what the server's
`fresh` mask does - `CoordinatePipeline.update()` is called once per reading,
and only the reporting node's channel is fed.

### Supporting the scanning rig

`src/Scanner.cpp` tracks the player with two sensors on a servo. Once it
reports a position, use the existing geometry:

```python
pipeline = CoordinatePipeline(CartesianGeometry())
result = pipeline.update((x_cm, y_cm), now_ms)
```

If it reports angle and distance instead, add a `Geometry` subclass that
converts them to `(x, y)` in `channels()` / `locate()`. Nothing downstream
needs to change.

## Measuring sensor noise

Before changing the hardware, the firmware or the filters, measure. Start the
server with the raw-reading recorder on:

```
REC=1 python Website/app.py
```

Every JSON line a node sends is written, unfiltered, to
`logs/raw-YYYYmmdd-HHMMSS.csv` at the repository root (`/logs` is gitignored;
the MAC is never written). Columns: `t_s` (server receive time from the start),
`label`, `node_id`, `role`, `has_turn`, `ms_since_turn`, `pulses`, `left_cm`,
`right_cm`, `avg_cm`, `angle_deg`, `scan_state`; `-1` is a no echo, and a field
the node did not send is empty.

With both nodes scanning, and the game page closed or at least off the
calibration screen (the calibration hold stops the servos, and multi-pulse does
nothing while they are held), run the bench test. It asks you to put a target
at each distance, for each Pulses setting, and labels those readings
(`p3-60cm`); the time spent moving the target is not labelled:

```
python Website/tools/bench_noise.py capture --distances 30 60 90 120 --pulses 1 3 --seconds 20
python Website/tools/bench_noise.py report logs/raw-YYYYmmdd-HHMMSS.csv
```

The report gives, per step, node and sensor (`left`, `right`, `avg`):

| Column | Meaning |
|--------|---------|
| `n` | readings |
| `no-echo%` | readings with no echo at all |
| `median` / `bias` | the middle reading, and how far it is from the distance in the label |
| `sigma` | 1.4826 x the median absolute deviation: the noise, ignoring outliers |
| `std` | standard deviation: the noise including outliers |
| `outlier%` | echoes more than 10 cm (`--outlier-cm`) from the step's median |
| `found%` | readings where both sensors agreed (`scanState` 0) |

A second table shows, per node, readings received without the scan turn, and
the outlier and no-echo rates in the first 150 ms after the node was given the
turn against the rest: if the early rate is clearly worse, the two nodes are
hearing each other at the hand-over. `--csv FILE` also writes the first table
out.

The bench test sets Pulses itself through `POST /api/pulses`
(`{"count": 1|2|3}`) and the labels through `POST /api/recording/label`
(`{"label": "..."}`, 404 when the server is not recording), and turns Pulses
back off at the end.
