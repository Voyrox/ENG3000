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

Each ESP32 is a servo scanner (`src/Scanner.cpp`; every pin and setting is in `src/Config.h`): two ultrasonic sensors side by side (left: trigger/echo on GPIO 26/34, right: GPIO 27/35) on a servo (GPIO 32) that turns towards whichever sensor sees the player, plus the dead-zone buzzer (GPIO 13). Every signal is on the board's VIN-to-EN header; the sensors' 3V3 is on the other one. Nodes scan one at a time: the server hands out turns (`TURN` / `HALT`) so their pings never overlap. It connects to the laptop hotspot, opens a persistent TCP socket on port `3000`, receives a numeric node ID, and sends a JSON line after every scan step:

```json
{"nodeId":1,"mac":"14:08:08:AB:F6:20","avg":82.40,"left":81.90,"right":82.90,"angle":112,"scanState":0}
```

- `avg` is the node's distance to the player (cm): the mean of the ultrasonics reading inside the scan range, or the nearer real echo if neither is; `-1` when neither heard anything
- `left` / `right` are the two ultrasonics (cm), `-1` for no echo
- `angle` is the servo angle the pair was read at: 90 points straight out into the play area, larger turns towards screen-left
- `scanState` is `0` found (both readings agree), `1` half-found (one sees the player), `2` lost (sweeping)

The server sends control lines back: `SYNC <tick>`, `TURN` / `HALT`, `ROLE LEFT` / `ROLE RIGHT` once the game's calibration screen has identified the node (again whenever it reconnects), which sets that mount's servo limits, and `AIM 90` / `SCAN` while the calibration screen is open / after it closes, `PULSES <n>` (multi-pulse, below), `LOOK <deg>` (handover, below), and `FARHOLD <0|1>` / `FARSTEER <0|1>` (far hold and far steer, below). A node boots holding its servo at 90 and sweeps only once told `SCAN`; the server sends `AIM 90` or `SCAN` the moment a node connects, so one that reboots mid-calibration never moves.

**Multi-pulse** is the `PULSES <n>` command: in found or half-found, the node takes `n` pulse pairs at one angle (1 = off, the default; at most 5), averages each sensor's readings with outliers left out, and only then reports one reading and moves. A lost pair still sweeps straight away. "Outliers" means: pulses with no echo are skipped, echoes outside the play area are skipped if any pulse saw the player inside it, then an echo more than `OUTLIER_TOLERANCE_CM` (20 cm) from the median is dropped (for two echoes that disagree, the nearer one is kept), and the rest are averaged. It is switched with the **Pulses** button on the game screen (top right: Off, 2, 3), which sends `{"type": "nodes:pulses", "count": 3}`; the server passes the count on to every node, and again to each node as it connects. With multi-pulse on, a node reports about once every `n` pairs while it has the player, instead of after every pair.

**Far hold and far steer** are two server → node lines, `FARHOLD <0|1>` and `FARSTEER <0|1>` (`src/CommandHandler.cpp`): `1` turns the setting on, `0` off. Far hold: after an echo at least `FAR_RANGE_CM` (100 cm) out, a lost pair keeps the servo where it is, for up to `FAR_HOLD_PAIRS` (3) lost pairs in a row, before the sweep starts. Far steer: a half-found echo that far out steers by `FAR_STEER_STEP_DEG` (1 degree) instead of `STEER_STEP_DEG` (3). Both are on in the firmware until the server says otherwise (`DEFAULT_FAR_HOLD`, `DEFAULT_FAR_STEER` in `src/Config.h`) and on in the server (`nodes_far` in `app.py`), which sends both lines to every node as it connects, and the changed one to every connected node when a switch changes:

```text
FARHOLD 1
FARSTEER 0
```

They are switched with **Far hold** and **Far steer** on the phone control panel (`/control`, `CON=1`, under *Sensors*). Those buttons go straight to the server, so they work with no game page open; `enabled` (boolean) is the new setting, and anything that is not `true` or `false` is ignored:

```json
{"action": "farHold",  "enabled": false}
{"action": "farSteer", "enabled": true}
```

The server answers every control panel with `far:status` (server → control panel), and sends it to each panel as it connects; `hold` and `steer` (booleans) are the two settings as the server holds them, and the panel's buttons show them:

```json
{"type": "far:status", "hold": true, "steer": false}
```

**Handover** (`Website/handover.py`): when one node has seen the player in one place for 5 s, the server aims the other node at them. A node's confidence is the share of its readings in the last 5 s that land inside the play area within 20 cm of their median point; dropped echoes count against it. It is confident at 80% or more, once it has been reporting for 5 s. While one node is confident and the other is not seeing the player there, the server sends the other `LOOK <deg>`, the bearing from it to that point. It is only ever sent while that node does not hold the turn, and is sent again whenever the bearing moves by more than 5 degrees, until the node's own reading agrees (within 30 cm). `LOOK` is not a hold: the node turns there and tracks, steers and sweeps from that angle as usual, after waiting out the swing (`LOOK_SETTLE_MS_PER_DEG`). Every node's confidence, the ± spread of its points and which node it is following go out in `nodes:update` as `confidence`, and the phone control panel shows them in its Sensors table. `HANDOVER=0 python Website/app.py` keeps the confidence but sends no `LOOK`; the control panel's Handover switch (Sensors) does the same while the server runs, and the server tells the panel which it is (`handover:status`). With the empty-room firmware, a node learning the room is never aimed, and one whose room is not learnt yet never counts as confident, because a chair is the steadiest "player" there is.

**Search** (`Website/search.py`, Aaron, 6 Oct): a node that loses the player is first aimed back at the cell they most likely are in, and only sweeps once it has checked there. For a still player the cell is the one both nodes' found and half-found readings put them in most often over the 3 s before the latest of them (each reading's own point: its distance plus the body radius along its servo angle; ties go to the latest); for a moving one, the cell they were walking into (`heading.py`, from the game's `track:update`, when its Tracking detector says they are moving; the Heading switch turns this off). From the node's first lost reading the server sends it `LOOK <deg>`, the bearing to the cell's centre within its servo's limits, and sends it again after each lost reading there, since the firmware sweeps a step after every lost reading; after 3 lost readings at the cell it sends nothing more and the sweep takes over. A found or half-found reading ends it. A node that has given up on a cell only looks again for someone seen after it gave up (Aaron: "after some time it should just give up if not found"); a cell needs 2 readings in the window, so one stray echo never sends it back. After a far echo (100 cm or more, Far hold on) the firmware's far hold goes first and the search starts on the last held reading. With no reading on the board in the last 5 s there is no cell, and a lost node sweeps as before. The search's `LOOK` goes before the handover's, which leaves a node being searched alone. Each node's search goes out in `nodes:update` as `search` (the State column on the control panel says "checking" and the cell, then "sweeping"). `SEARCH=0 python Website/app.py` starts with it off; the control panel's Search switch (Sensors) turns it off and on while the server runs (`search:status`). It needs no new firmware. The game resets it with `round:start` (which restarts the server-side chain too), and `calibration:update` gives it the cells' depths.

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

The game puts each node on the screen edge at the centre of an outer column. How the player is placed is switched on the phone's `/control` page only (Aaron, 5 Oct; the game board draws one cursor and no buttons): **Dynamic** (the default), **Line of sight**, **Trilateration** or **Average**, under *Placing the player*. Picking one of the last three turns Dynamic off. With Dynamic on, its button says which one it is following (e.g. `Dynamic (TRI)`), or which of its rules is placing the player: `FAR` (far priority: both nodes read past 110 cm and agree), `A1` / `A3` (the near node in its far corner), `MID`, `COL L` / `COL R` (the column lock: where the two servo lines cross) or `L` / `R` (a lone confident node); each rule has its own switch under *Dynamic's rules*. **Compare**, beside it, rings where line of sight, trilateration and the average put the player (LOS, TRI, AVG) on the control panel's pad, while the cyan cursor follows the one placing the player (the thick ring). The game's sensor panel lists all three positions. See *Placing the player* under the filtering pipeline. With no `angle` from either node there is no line of sight, and every method is trilateration.

**Out of bounds** appears in one case only: both nodes are lost (Aaron, 5 Oct). Each node's last *n* readings are scored as the control panel shows them - *found* +1, *half* 0, *lost* -1 - and a node whose scores add up to 0 or less is lost, so the odd found reading among lost ones does not stop it, and a node mostly finding the player never is. *n* is 21 by default; set it on the phone control panel under *Out of bounds* (minus and plus), which also shows each node's score now. The game keeps it in that browser, and passes it to the server when `SERVER_FILTERING` is on. Each reading counts once, when it arrives; a node waiting for its turn keeps the readings of its last one, and a node is not lost until it has had *n* readings in the round. A position off the board keeps the player on the edge square, a tenth of a square inside the edge (`EDGE_INSET`), and the game carries on; the sensor panel says `off board: edge`. Unusable readings are ridden out on the last square for as long as they last. If neither node sends anything for 5 s (`tuneSensor({ offlineMs })`), or the server says both are offline, the game says **Sensors offline** instead and the round waits. Waiting for a first position shows no message.

The board is drawn with the row **nearest the screen at the top**, so stepping towards the screen moves the cursor up. Only the drawing is flipped (`boardRow()` in `game.js`, one switch, `NEAR_ROW_AT_TOP`): grid row `gy = 0` is still the row nearest the screen everywhere else, and left/right is unchanged. The phone control panel's touchpad maps onto the board as drawn. A finger on it takes the game's cursor over from whichever mode is running (sensors or mouse) and lifting it hands the cursor straight back; nothing else on the game screen changes (Aaron, 5 Oct). The sensors keep running underneath - the sensor panel, LIVE STATS and LIVE DATA carry on - but while the finger is down they cannot hold the round, put up Out of bounds or Sensors offline, or raise the too-close alert, and only the finger's cursor scores. There is no Remote mode any more: the panel's *Input* row is Sensors and Mouse, and *Start sensor round* replaces *Start remote round*.

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

The phone control panel (`/control`, `CON=1`) has **Learn room** and **Forget room** under *Empty room*. Each asks first, then sends `{"action": "room", "room": "learn"|"forget"}`, which the server turns into `LEARN` / `FORGET` for every connected node itself, with no game page needed (forgetting also wipes the room from the node's flash). The panel's Sensors table shows each node's room from the `room` field of its readings: none, learning or learnt (`--` for firmware without the room filter).

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

The game also passes the control panel's filter switches on to the server,
so the server's chain filters the way the game does. Each goes browser →
server (`syncServerFilterSetup()` in `canvas.js`), only while the server
reports the flag on, whenever the switch changes, and again after the socket
reconnects (a restarted server has forgotten them):

```json
{"type": "filter:kalman",         "on": false}
{"type": "filter:deadZone",       "on": true}
{"type": "filter:cellDecision",   "on": true}
{"type": "filter:trackMoving",    "on": true}
{"type": "filter:cellConfidence", "on": false}
{"type": "sensor:farHalf",        "on": true}
{"type": "sensor:dynamicRules",   "rules": {"farPriority": true, "confidenceNode": true, "columnLock": false, "loneNode": true, "cornerNode": true}}
```

The control panel never sends these itself. Its button sends
`{"action": "<action>", "enabled": true|false}` to the server, which relays it
to every game page as `remote:command`; the game sets its own switch and then
sends the message above. Dynamic's rule buttons send
`{"action": "dynamicRules", "rules": {"<switch>": true|false}}`, only the
switch pressed; the game's `sensor:dynamicRules` carries all five. The server
applies each one to its chain (`apply_filter_event()` in `app.py`, the setters
in `serverFilter.py`); a message without its field is ignored, and so is a
`sensor:dynamicRules` with an unknown switch or a value that is not `true` or
`false`. A `sensor:dynamicRules` changes only the switches it names.

| Message | Field | `/control` switch (section) | Panel `action` | Default | Server side |
|---|---|---|---|---|---|
| `filter:kalman` | `on` (boolean) | Kalman (*Placing the player*) | `kalman` | on | `set_kalman()`, `FilterConfig.kalman` |
| `filter:deadZone` | `on` (boolean) | Dead zone (*Too close*) | `deadZone` | on | `set_dead_zone()`, `FilterConfig.dead_zone` |
| `filter:cellDecision` | `on` (boolean) | Cell decision (*Placing the player*) | `cellDecision` | on | `set_cell_decision()`, `FilterConfig.cell_decision` |
| `filter:trackMoving` | `on` (boolean) | Tracking (*Placing the player*) | `trackMoving` | off | `set_track_moving()`, `FilterConfig.track_moving` |
| `filter:cellConfidence` | `on` (boolean) | Cell confidence (*Placing the player*) | `cellConfidence` | on | `set_cell_confidence()`, `FilterConfig.cell_confidence` |
| `sensor:farHalf` | `on` (boolean) | Far half (*Out of bounds*) | `farHalf` | on | `set_far_half()`, `FilterConfig.far_half` |
| `sensor:dynamicRules` | `rules` (object: `farPriority`, `confidenceNode`, `columnLock`, `loneNode`, `cornerNode`, each boolean) | Far priority, Confidence, Far corners, Column lock, Lone node (*Dynamic's rules*) | `dynamicRules` | all on | `set_dynamic_rules()`, `FilterConfig.far_priority`, `confidence_node`, `column_lock`, `lone_node`, `corner_node` |

What each switches, from the game's `tuning` comments in `game.js` (the
Python copy is the `FilterConfig` field named). **Kalman**: see *Kalman
switch* below. **Dead zone**: on, a node's raw reading is too close when its
point along the servo line is in the 10 cm strip at the front of the grid;
off, the raw reading itself is checked, whatever the angle. **Cell
decision**: on, the cell is decided by the margin, the dwell and each node
against itself; off, by the older majority vote. **Tracking**: while the
player is moving, the cell decision follows them with a shorter dwell.
**Cell confidence**: the cell decision uses how sure the game is that the
player has stood in each cell. **Far half**: a half reading whose own point
is in the back row scores +1 towards Out of bounds, as found does.
**Dynamic's rules**: see *Placing the player* below.

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
the end-to-end latency is measured.
Hardening, so one bad reading cannot run away with a track: a NaN or ±inf
reading is missing, like no echo (`app.py` keeps it out of the node's median
window too); the 250 ms lead cap counts from the last accepted reading, so a
run of no-echo readings cannot push a prediction further; and a distance
channel's output is clamped to [0, 400] cm (`DEFAULT_MAX_RANGE_CM`), while a
signed channel (`negative_is_missing` off, e.g. an x coordinate) is not.
`PathPredictor` feeds its trackers raw readings, so it also turns on a spike
gate - a reading whose normalised innovation squared is above 6.63
(`DEFAULT_NIS_GATE`, χ² 99 %, 1 degree of freedom) is dropped, unless 3 gated
readings in a row agree to within 20 cm (`REACQ_READINGS`,
`REACQ_SPREAD_CM`), which restarts the track on the latest (the player really
moved) - and a velocity limit of 300 cm/s (`DEFAULT_V_MAX_CM_S`). Both stay
off in the filtering chain's Kalman stage, for parity with `game.js`'s
`kalmanUpdate()`. Tests are in
`Website/tests/test_tracking.py` and `Website/tests/test_serverFilter.py`.

### Placing the player: Dynamic, line of sight, trilateration, average

The nodes scan one at a time (the server hands out 1 s turns), so the two
are never read at the same moment, and a node that has lost the player keeps
reporting whatever its beam hits while it sweeps. The position methods
(`solvePositions()` in `game.js`, `TwoSensorGeometry(method=...)` here):

- **Dynamic** (`dyn`, the default): first three rules (`dynamicRule()`,
  `TwoSensorGeometry._rule()` here; Aaron, 5 Oct), checked in this order.
  Each has a switch on the control panel, under *Dynamic's rules*
  (`setDynamicRules({ farPriority, cornerNode, columnLock, loneNode })`, kept
  in the browser; Python `FilterConfig(far_priority=..., corner_node=...,
  column_lock=..., lone_node=...)`), and the Dynamic button there says which one is placing
  the player. Far priority (`farPriority`, `far_priority`) comes first:
  - **Far priority** (`Dynamic (FAR)`; Aaron, 6 Oct). Past 110 cm a node
    hears the player rarely and mostly with one head: on the rig on 6 Oct
    two thirds of the readings past 110 cm were half, and most runs of them were a
    single reading, so the far position turned up for a tick or two and the
    no-echo and stray nearer readings in between took it back (and pushed
    the nodes towards Out of bounds). When both nodes have read past
    `farPriorityCm` (110; the node's own distance) in the last `farSeenMs`
    (1.5 s, which covers the other node's turn), found or half, and the two
    readings agree - their distances, plus the body radius, cross inside
    both nodes' beams as each was aimed (with the aim tolerance), on the
    board - the player is at that crossing and is not Out of bounds,
    whatever the readings in between. Two far readings that do not agree
    are not the player and change nothing: on 6 Oct the left node read
    113 cm with its servo at its stop (160°) while the right one read 135 cm
    straight out; pairs like that came up in 230 updates of those logs.
    A node that finds the player nearer than 110 cm twice in a row (both
    heads) ends it at once. With Dynamic off it does nothing. Replaying the
    6 Oct logs (00:46-01:09): it placed the player in 288 of 11,280 updates,
    always in the back half, and 29 fewer were Out of bounds. The parity
    trace has segment 31 for it and a run of Dynamic with it off.
  1. **Far corners** (`Dynamic (A1)` / `(A3)`). A1 and A3, the far-left and
     far-right squares, are far from the opposite node - the back-left square
     is some 156 cm from the right node, at a shallow angle. When the left
     node is confident (rule 3) and its own reading puts the player in A1,
     that reading places them and the right node's readings are left out;
     the same for the right node and A3.
  2. **Column lock** (`Dynamic (MID)`, `(COL L)`, `(COL R)`). Each node's servo
     points where it last found or half-found the player. If both have done
     so in the last 1.5 s, where the two servo lines cross says the column,
     whatever the methods make of the distances:
     - **The centre**: the lines cross in the centre column. x is the
       crossing's, kept 8 cm inside the column so the column hysteresis
       cannot hold the player in the column they came from; y is the
       steadiest method's. Once the lines have crossed in the centre, the
       player stays there for 1 s while both nodes still see them, even if
       the crossing strays outside: standing still in the centre must never
       touch a side column (Aaron).
     - **The sides**: the lines cross at least 20 cm inside the left or
       right column (`sideLockDepthCm`), i.e. x 30 cm or less, or 120 cm or
       more. No hold, and it ends any centre hold. Locking a side column
       wherever the lines crossed in it would have cost the 4 Oct
       walk-centre a quarter of its time in the centre column: the servos
       read 20-30° further in than the player, so the crossing strays into
       a side column now and then.

     (Aaron's first form of the centre, LEFT above 90 and RIGHT below 90,
     holds anywhere between the two nodes, which sit in the middle of the
     outer columns: on the 4 Oct centre run it said centre at L-80 every time
     and at R-80 61 % of the time, because the servos read further in than
     the player - L-80 read 112°, R-80 59.5°. The crossing said centre at
     L-80 0 %, R-80 38 %, and C-40/C-80/C-120 100/100/81 %.)
  3. **Lone node** (`Dynamic (L)` / `(R)`). A node whose last two readings found
     the player (both heads), the latest in the last 1.5 s - so it lasts
     through the other node's 1 s turn - and whose own reading (its distance
     along its servo line) is inside the play area - across the board, and
     between its column's near and far edges - is confident. If only one
     node is, that reading places the player and the other node's readings
     are left out. When both are, the steadiest method places the player.

  `tuneSensor({ centreSeenMs, centreHoldMs, sideLockDepthCm,
  confidentReadings, confidentMs })`, Python `FilterConfig(centre_seen_ms=...,
  centre_hold_ms=..., side_lock_depth_cm=..., confident_readings=...,
  confident_ms=...)`. On the rig on 5 Oct (serial logs 19:23-19:43, replayed
  through `filterRules.py`), while the two servo lines crossed in the centre
  column the cursor was in a side column 7 % of the time before the rules,
  and once in 1,507 readings with them (A1's rule, which comes first). The
  side lock placed 182 of 2,868 readings and the far corners 18. The
  play-area check keeps out what the left node found there turned fully in -
  something 9 cm in front of the screen line - and off the left edge of the
  board. On the 4 Oct centre run the rules take C-120 from 62 % to 99 % in
  its column (column changes 23 to 2) and walk-centre from 86 % to 100 % (15
  to 0); L-80, C-40 and C-80 stay at 100 %; R-80 stays poor (4 % to 0 %): the
  right node reads 59.5° with the player straight in front of it, so the
  lines cross in the centre.

  Otherwise Dynamic follows whichever of the other three has kept the
  player in one square of the board the longest (`dynamicLeader()`,
  `DynamicPicker` here). A method whose square keeps changing - bouncing
  between columns - builds up no time, so it is passed over while another
  holds still. Time in a square counts up to 1 s (`tuneSensor({
  dynamicSteadyMs })`, Python `FilterConfig(dynamic_steady_ms=...)`); past
  that a method is fully steady, and of two fully steady methods line of
  sight wins, then trilateration, then the average. So a method stuck on
  furniture can lead only until line of sight has held its own square for
  1 s. A square is a cell, or off the board (which counts as a square of
  its own); a method with no position is out of the running. Replaying the
  4 Oct centre run (`logs/centre-20261004-154946`) through `filterRules.py`,
  Dynamic changed column least on every spot (C-120: 23 times, against 29-33
  for the others; walk-centre: 22 against 27-32) and kept x in the spot's
  column as often as the best single method, or more (walk-centre 77 %,
  against 61-73 %) - except at R-80, where every method was poor (servo aims
  ~15° off) and Dynamic held steady in the wrong column (4 %, line of sight
  37 % with 24 column changes).
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
- **Trilateration** (`tri`): where the two distance circles cross, using
  each node's latest distance however old. The servo angles only check the
  crossing: it must lie inside both sensors' beams - within 7.5° of where each
  servo points, from the datasheet's beam of under 15° (HC-SR04; the supplied
  RCWL-1601 is a pin-compatible copy) - and each distance must be inside the
  sensors' 2-400 cm range. A crossing outside a beam means one node is looking
  at something else (furniture, as a rule), so it is refused, and the nearer
  node places the player by its own distance along its servo angle, as it
  does when only one node has a reading. `tuneSensor({ triBeamHalfDeg: 10 })`
  widens the beam live; Python: `FilterConfig(tri_beam_half_deg=...)`. With
  the aim tolerance on (below) the check allows 20° more.
- **Average** (`avg`): the midpoint of the two.

The switch is on the phone control panel only (`/control`, server started
with `CON=1`), under *Placing the player*, which shows which method is in
use. Its pad draws Compare's rings (LOS, TRI, AVG) where each method puts the
player, and the sensors' cursor, both also while a finger is on the pad; it
lists each method's (x, y) - the one placing the player, or Dynamic is
following, in bold - and its Sensors table gives each node's servo
angle and scan state (found, half, lost) from the node's latest message. Its
buttons come from the game's status, so a new method appears there by itself.
In the browser console, `tuneSensor({ losAccelCmS2, losBearingFoundDeg,
losBearingHalfDeg })` changes the tracker live; `setPositionMethod("tri")`
switches method. The Python side takes the same through `FilterConfig`
(`los_*`), and with `SERVER_FILTERING` on the switch is sent to the server
(`{"type": "position:method", "method": "los"}`).

In simulation - the real `game.js`, two scanner nodes taking 1 s turns, servos
stepping 3° and sweeping when they lose the player, 15° beams, 2 cm distance
noise, a player walking the board and pausing - over three seeds:

| Method | Median error | 90th percentile | Right cell |
|---|---|---|---|
| Before (main) | 7.0 cm | 24.7 cm | 58 % |
| Line of sight | 6.3 cm | 16.8 cm | 65 % |
| Trilateration | 2.3 cm | 22.8 cm | 63 % |
| Average | 3.8 cm | 19.1 cm | 63 % |

With furniture at (60, 100) cm (`--furniture 60,100`), same turns:

| Method | Median error | 90th percentile | Right cell |
|---|---|---|---|
| Line of sight | 10.6 cm | 58.4 cm | 56 % |
| Trilateration | 3.7 cm | 31.9 cm | 61 % |
| Trilateration, no beam check | 13.0 cm | 40.0 cm | 61 % |
| Average | 7.7 cm | 37.4 cm | 62 % |

Reproduce it with `node Website/tools/simulate_positions.js` (options:
`--turn-ms 1000,250,0` - 0 is both nodes at once - `--furniture 140,125`,
`--seeds`, `--methods`, and `--site` to score another copy of `public/`; the
"Before" row is main at 247006b scored that way).

Trilateration is the most exact while the player stands still and the worst
while they move (a distance a turn old is still right for a still player).
With both nodes read at once, all three are within 2 cm (median). Furniture
inside the play area fools a scanner: it "finds" it exactly as it finds a
player. Trilateration's beam check catches most of that: the crossing of the
furniture's distance with the player's is not where both nodes point. What a
refused crossing falls back to matters as much. Placing the player straight
in front of the nearer node, with no angle, scored worse than no check at all
(median 51.5 cm with furniture), so the fallback takes the node's servo angle.
The 7.5° beam is the datasheet's; the rig's is not measured. Check the real
rig with Compare.

Each channel also starts again when its node comes back after a silence
longer than the hold (350 ms) - the other node's turn, as a rule - so the
median and the gate do not hold the new readings back with where the player
was a turn ago.

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

**Kalman switch.** The control panel's *Kalman* button (`/control`, needs
`CON=1`) turns both of the game's Kalman filters off and on again:
`tuning.kalman`, `setKalman()`, `FilterConfig.kalman`. Off, each node's
distance goes median → FFT, and line of sight places the player at each new
reading's own point along the node's line of sight, with no gate and nothing
kept from the readings before. It is for testing whether a wrong position comes
from the filters or from the readings. The servos never see it: each node
steers on its own pulse pairs. `app.py`'s per-node `filtered_distance` keeps
its Kalman either way. The parity trace has a run of line of sight and one of
Dynamic with it off.

**Angle limit.** The grid is 150 cm across and 160 cm long, with the nodes at
(25, 0) and (125, 0). At each servo angle a node's line runs a set distance
before it leaves the grid: 160 cm straight down it, 203 cm to the far opposite
corner, and only 32.6 cm towards the near side wall at the servo's limit
(`angleLimitCm()` / `angle_limit_cm()`). A filtered distance further than
that, plus 5 cm (`tuning.angleLimitToleranceCm`), is not a player on the grid:
line of sight does not use the reading, and for Dynamic's rules it counts as
no reading (no found streak, no servo line for the column lock, no lone-node
point). Trilateration ignores the limit, and the average's trilateration half
with it. The control panel's *Angle limit* button turns it off and on again:
`tuning.angleLimit`, `setAngleLimit()`, `FilterConfig.angle_limit`,
`filter:angleLimit` to the server. The parity trace has a run of line of sight
and one of Dynamic with it off.

**Tri aim tolerance.** In the centre test (4 Oct) the left servo reported
about 20° further in than the taped spots needed (112° at L-80, 141° at C-80,
134° at C-120). Trilateration's beam check then refused crossings that were
3 cm from the spot, and the nearer node's own point it used instead was
28 cm off, on the edge of the wrong column. With the aim tolerance on, the
beam check lets a crossing be 20° further off each servo's aim than the beam
(7.5 + 20 = 27.5°, plus the player's half-width to the side); whether a node
is in play still follows the beam alone. Replaying the centre test's 1,441
readings: at C-120 the crossing is used for 64 % of readings instead of 5 %
and the median error falls from 35 to 15 cm, on the two walks from 7 % to
39 %, and the empty room still gets no two-node fix. The control panel's
*Tri aim tolerance* button turns it off and on again:
`tuning.triAimTolerance` / `triAimToleranceDeg`, `setTriAimTolerance()`,
`FilterConfig.tri_aim_tolerance` / `tri_aim_tolerance_deg`,
`filter:triAimTolerance` to the server. The parity trace has a run of
trilateration and one of Dynamic with it off. Reseating the left servo's
horn would remove the offset itself; compare with the switch off then.

The game steps a node's filters only on that node's new readings, not on
every animation frame. On the server a no-echo reading (negative) is skipped
rather than put into the median, and the median takes the upper of the two
middle values, as the game's does. The firmware reports the **settled angle
at which** each pair was measured, before moving the servo. For `app.py`'s
per-node `filtered_distance`, a change of angle resets the median, Kalman and
FFT windows: ranges at different bearings are not samples of the same target.
Its FFT uses the measured sampling interval and runs only when the current
window is approximately uniform (within 20%); otherwise the timestamp-aware
Kalman estimate is published. Both the browser and the optional server
coordinate pipeline also reset the affected channel (including its slew gate)
when the reported angle changes; a missed echo at a new angle cannot project
the old range onto that bearing. Their FFT also takes its rate from the
window's own timestamps, but runs on an uneven window too.

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
| `TwoSensorGeometry` | Today's rig: LEFT and RIGHT scanners, placed by line of sight (`LineOfSightTracker`), trilateration or their average |
| `UltrasonicArrayGeometry` | The earlier three-sensor rig, one column each (replays V1 logs) |
| `CartesianGeometry` | A rig that reports `(x, y)` itself, e.g. the servo scanner |
| `CellStabiliser` | Majority vote over recent cells |
| `HoldPolicy` | Abstract: counts bad readings (the pipeline rides them out until nobody is found) |
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
the game says Sensors offline once neither node has sent anything for 5 s, or
both are offline, because the server only recomputes on a new reading.) In `game.js`, that function
replaces what `updateSensorCursor()` computes today:

- store it as `gameState.sensor`, and drive the cursor from its `gx` / `gy`;
- raise the alert when `c.status === "too-close"`.

The game state lives inside `game.js`'s module scope, which is why this goes
through a function rather than `canvas.js` touching it directly.

**6. Delete the JS copy.** Remove the conditioning, column selection, vote and
hold logic from `game.js`. Keeping both means two sources of truth that will
drift apart.

### Behaviour to decide before integrating

**Hold policy.** Since 5 Oct, `game.js` and `CoordinatePipeline` ride
unusable readings out on the last cell for as long as they last; only nobody
found (out of bounds) ends a hold. The pipeline still counts bad readings with
its `HoldPolicy` (`held_for`), but no longer asks it whether to stop.
`StreakHold` (a *consecutive* streak, the default) and `MajorityWindowHold`
(releases once *most* of the last N readings are bad) keep their
`keep_holding()` for `tools/chain_replay.py` and experiments.

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
