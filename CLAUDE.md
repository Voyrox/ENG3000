# CLAUDE.md

ENGG3000 Group 1 — an ultrasonic whack-a-mole game. ESP32 sensor nodes report
distances over TCP to a Python server (`Website/app.py`), which relays them over
WebSocket to a canvas game in the browser (`Website/public/`).

These rules apply to everything committed to this project.

## Design

**Everything must be modular.** One responsibility per file and per class. A
screen lives in its own file under `Website/public/displays/`; a firmware
subsystem gets its own `.cpp`/`.h` pair under `src/`. If a file is doing two
jobs, split it.

**Use object-oriented design wherever it fits.** Model real things as classes
with a small public interface — a sensor, a filter stage, a UI component.
Prefer composition over long functions, and put the part expected to change
behind an interface. `Website/filterRules.py` is the reference example:
`Geometry` and `HoldPolicy` are abstract, so new hardware or a new rule is a
new subclass, not an edit to the pipeline.

**Keep components data-agnostic.** A UI component takes plain data and knows
nothing about where it came from — `CoordinateMap` takes `(x, y)` in cm, not
sensor readings. Put the translation in a small, named adapter so swapping the
data source means rewriting the adapter, not the component.

**Do not duplicate a rule across layers.** The same logic in firmware, server
and browser drifts apart. Pick one owner. If a port is in progress, say so in
both places and delete the old copy when it lands.

## Conventions

- **Units in names.** `distance_cm`, `hold_ms`, `max_speed_cm_per_s`. Never
  a bare `distance` or `timeout`.
- **No magic numbers.** Every tunable is a named constant with its unit and a
  comment saying *why* it has that value.
- **Coordinates.** `x` runs left to right across the play area, `y` is depth
  from the screen. Grid cell `(0, 0)` is bottom-left — nearest the screen, on
  the left — and `(2, 2)` is top-right.
- **No-echo is not zero.** A negative ultrasonic reading means no echo. Treat
  it as missing, never as 0 cm.
- **Comments explain why,** not what the next line does.

## Safety — do not break these

- **The proximity alert reads RAW readings, never filtered ones.** A median
  window full of safe distances smooths away the very spike the alert exists
  to catch. `ProximityGuard` in `filterRules.py` and `readSensorCoordinate()`
  in `game.js` both enforce this; keep it that way in any rewrite.
- **Filters must be causal.** A filter may use the current and earlier
  readings only. A centred window looks better on a graph and is useless in a
  live game.
- **The alert threshold can only become more cautious.** Calibration may raise
  it, never lower it below the 10 cm floor.
- **Ultrasonic timing.** HC-SR04 needs a measurement cycle of at least 60 ms,
  or the previous ping's echo is read as the next one and looks like noise.

## Testing

- **Test logic headless, before committing.** Python uses the standard-library
  `unittest`: `python -m unittest discover -s Website/tests`.
- **A port needs a parity test, not just unit tests.** `filterRules.py` is
  checked against a stream recorded from the real `game.js`. If you change a
  filtering rule in the JS, regenerate the recording with
  `node Website/tests/generate_parity_trace.js`, or the Python silently falls
  out of step.
- **Look at UI changes rendered.** Canvas bugs — overlaps, clipped text,
  mis-encoded glyphs — do not show up in a syntax check.

## Web client

- **Bump the cache-buster.** When you change any file under `Website/public/`,
  raise the `?v=` number on **every** `<script>` tag in
  `Website/template/index.html`, or browsers keep running the old file.
- **Script order matters.** Tags use `defer` and run in document order. A file
  that defines a class another file uses must be listed first.
- **Prefer `\u` escapes for non-ASCII in JS strings** (`"\u25BC"`, not `"▼"`),
  so they render correctly whatever encoding the host page declares.

## Interfaces between subsystems

Firmware, server and browser are owned by different people. When you change a
message crossing a boundary — the ESP32 TCP payload, `nodes:update`, or any
WebSocket event — update the shapes documented in `README.md` in the same
commit, and tell whoever owns the other end.

## Git

- **Never commit generated, binary or captured data.** No `__pycache__/`,
  `*.pyc`, `.pio/`, `logs/`, KiCad `*.lck` lock files or KiCad
  `*-backups/` zips. Check `git status` before every commit.
- **Work on a branch** and merge through a pull request. Don't commit straight
  to `main`.
- **Check for a detached HEAD before committing.** This repo has lost work to
  it before — `git status` must name a branch.
- **One logical change per commit,** with a message that says what changed and
  why.
