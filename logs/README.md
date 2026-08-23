# Session logs

Written automatically by the Flask server at the end of every round.

Each round produces two files:

    game-001-2026-08-24_03-15-42.json    full capture: readings, calibration, tuning, per-sensor summary
    game-001-2026-08-24_03-15-42.csv     the same readings, one row per reading, columns grouped by sensor

The number increments per round and is derived from the filenames already
present, so it survives a server restart and never reuses a number. It is also
written inside the JSON as `round.gameNumber`, so a renamed file stays traceable.

Recording starts when a round begins and stops when it ends - whether that is
the timer expiring, running out of lives, or quitting. `round.endedBy` records
which.

Turn it off from the browser console with `autoRecord(false)`.
