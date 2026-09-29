"""
bench_noise.py - bench test for the scanner nodes' ultrasonic noise.

Needs the server running with the raw-reading recorder on (REC=1, see
Website/sessionRecorder.py) and both nodes connected and scanning.

  capture  walks you through placing a target at each distance, for each
           Pulses setting, and labels the recorded readings (e.g. p3-60cm):

      python Website/tools/bench_noise.py capture --distances 30 60 90 120 --pulses 1 3

  report   reads a recording and prints, for each step, node and sensor: the
           readings, how many had no echo, the median and its bias from the true
           distance, the spread, and how many were outliers. Then, per node,
           how readings just after the scan turn was handed over compare with
           the rest (cross-talk between the two nodes shows up there):

      python Website/tools/bench_noise.py report logs/raw-20261001-101500.csv

Only labelled readings count; the gaps while the target is moved are left out.
Standard library only.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Optional

# (name in the report, column in the recording)
SIGNALS = (("left", "left_cm"), ("right", "right_cm"), ("avg", "avg_cm"))
HANDOVER_SIGNAL = "avg"

MAD_TO_SIGMA = 1.4826             # MAD -> standard deviation, for normal noise
DEFAULT_OUTLIER_CM = 10.0         # further than this from the step's median
HANDOVER_WINDOW_MS = 150.0        # "just after the turn was handed over"
DEFAULT_SERVER = "http://localhost:5000"

_TRUE_DISTANCE = re.compile(r"(\d+(?:\.\d+)?)cm", re.IGNORECASE)


# --- Reading a recording -----------------------------------------------------

@dataclass(frozen=True)
class Row:
    """One recorded reading. values: signal name -> cm, None if not sent;
    a negative value is a no echo."""

    t_s: float
    label: str
    node: str                       # LEFT / RIGHT once assigned, else node<id>
    has_turn: bool
    ms_since_turn: Optional[float]
    pulses: Optional[int]
    values: dict
    scan_state: Optional[int]


def _number(text):
    try:
        value = float(text)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _whole(text):
    value = _number(text)
    return None if value is None else int(value)


def read_recording(path):
    rows = []
    with open(path, newline="", encoding="utf-8") as handle:
        for record in csv.DictReader(handle):
            node_id = record.get("node_id") or "?"
            rows.append(Row(
                t_s=_number(record.get("t_s")) or 0.0,
                label=record.get("label") or "",
                node=record.get("role") or f"node{node_id}",
                has_turn=record.get("has_turn") == "1",
                ms_since_turn=_number(record.get("ms_since_turn")),
                pulses=_whole(record.get("pulses")),
                values={name: _number(record.get(column)) for name, column in SIGNALS},
                scan_state=_whole(record.get("scan_state")),
            ))
    return rows


def true_distance_cm(label):
    """The target distance a step label names (p3-60cm -> 60.0), or None."""
    match = _TRUE_DISTANCE.search(label)
    return float(match.group(1)) if match else None


# --- Statistics ---------------------------------------------------------------

@dataclass(frozen=True)
class SignalStats:
    label: str
    node: str
    pulses: Optional[int]
    signal: str
    n: int                              # readings, echo or not
    no_echo_pct: Optional[float]
    median_cm: Optional[float]
    bias_cm: Optional[float]            # median - true distance
    robust_sigma_cm: Optional[float]    # 1.4826 x MAD
    std_cm: Optional[float]
    outlier_pct: Optional[float]        # of the echoes
    found_pct: Optional[float]          # scanState 0, of the step's readings


def _pct(part, whole):
    return 100.0 * part / whole if whole else None


def describe(readings, outlier_cm, true_cm=None):
    """Numbers for one list of readings (None = not sent, <= 0 = no echo):
    (n, no_echo_pct, median, bias, robust_sigma, std, outlier_pct)."""
    sent = [value for value in readings if value is not None]
    echoes = [value for value in sent if value > 0]
    if not echoes:
        return len(sent), _pct(len(sent), len(sent)), None, None, None, None, None
    median = statistics.median(echoes)
    deviations = [abs(value - median) for value in echoes]
    robust_sigma = MAD_TO_SIGMA * statistics.median(deviations)
    std = statistics.pstdev(echoes)
    outliers = sum(1 for deviation in deviations if deviation > outlier_cm)
    bias = None if true_cm is None else median - true_cm
    return (len(sent), _pct(len(sent) - len(echoes), len(sent)), median, bias,
            robust_sigma, std, _pct(outliers, len(echoes)))


def group_steps(rows):
    """Labelled rows by (label, node, pulses), in the order they were recorded."""
    groups = {}
    for row in rows:
        if row.label:
            groups.setdefault((row.label, row.node, row.pulses), []).append(row)
    return groups


def summarise(rows, outlier_cm=DEFAULT_OUTLIER_CM):
    stats = []
    for (label, node, pulses), step in group_steps(rows).items():
        states = [row.scan_state for row in step if row.scan_state is not None]
        found_pct = _pct(sum(1 for state in states if state == 0), len(states))
        for name, _ in SIGNALS:
            n, no_echo, median, bias, sigma, std, outlier = describe(
                [row.values[name] for row in step], outlier_cm, true_distance_cm(label))
            stats.append(SignalStats(label, node, pulses, name, n, no_echo, median, bias,
                                     sigma, std, outlier, found_pct))
    return stats


@dataclass(frozen=True)
class HandoverStats:
    node: str
    off_turn: int                   # readings received without the turn
    early_n: int                    # within HANDOVER_WINDOW_MS of the TURN
    early_outlier_pct: Optional[float]
    early_no_echo_pct: Optional[float]
    late_n: int
    late_outlier_pct: Optional[float]
    late_no_echo_pct: Optional[float]


def handover(rows, outlier_cm=DEFAULT_OUTLIER_CM, window_ms=HANDOVER_WINDOW_MS):
    """Per node: readings just after it was handed the turn against the rest,
    each judged against its own step's median."""
    medians = {}
    for key, step in group_steps(rows).items():
        echoes = [row.values[HANDOVER_SIGNAL] for row in step
                  if row.values[HANDOVER_SIGNAL] is not None and row.values[HANDOVER_SIGNAL] > 0]
        medians[key] = statistics.median(echoes) if echoes else None

    tallies = {}   # node -> [off_turn, early rows, late rows]
    for key, step in group_steps(rows).items():
        node = key[1]
        tally = tallies.setdefault(node, [0, [], []])
        for row in step:
            if not row.has_turn:
                tally[0] += 1
            elif row.ms_since_turn is not None:
                tally[1 if row.ms_since_turn < window_ms else 2].append((key, row))

    def rates(entries):
        sent = [(key, row.values[HANDOVER_SIGNAL]) for key, row in entries
                if row.values[HANDOVER_SIGNAL] is not None]
        no_echo = sum(1 for _, value in sent if value <= 0)
        judged = [(key, value) for key, value in sent if value > 0 and medians[key] is not None]
        outliers = sum(1 for key, value in judged if abs(value - medians[key]) > outlier_cm)
        return _pct(outliers, len(judged)), _pct(no_echo, len(sent))

    result = []
    for node, (off_turn, early, late) in tallies.items():
        early_outlier, early_no_echo = rates(early)
        late_outlier, late_no_echo = rates(late)
        result.append(HandoverStats(node, off_turn, len(early), early_outlier, early_no_echo,
                                    len(late), late_outlier, late_no_echo))
    return result


# --- Report ---------------------------------------------------------------------

def _fmt(value, decimals=1):
    return "-" if value is None else f"{value:.{decimals}f}"


def format_table(headers, rows, text_columns):
    """Fixed-width table: the first `text_columns` left-aligned, numbers right."""
    widths = [max([len(header)] + [len(row[i]) for row in rows]) for i, header in enumerate(headers)]

    def line(cells):
        return "  ".join(cell.ljust(width) if i < text_columns else cell.rjust(width)
                         for i, (cell, width) in enumerate(zip(cells, widths))).rstrip()

    return "\n".join([line(headers), line(["-" * width for width in widths])]
                     + [line(row) for row in rows])


STATS_HEADERS = ("step", "node", "pulses", "sensor", "n", "no-echo%", "median",
                 "bias", "sigma", "std", "outlier%", "found%")


def stats_cells(stat):
    return [stat.label, stat.node, "-" if stat.pulses is None else str(stat.pulses), stat.signal,
            str(stat.n), _fmt(stat.no_echo_pct), _fmt(stat.median_cm), _fmt(stat.bias_cm),
            _fmt(stat.robust_sigma_cm), _fmt(stat.std_cm), _fmt(stat.outlier_pct),
            _fmt(stat.found_pct)]


HANDOVER_HEADERS = ("node", "off-turn", "early n", "early outlier%", "early no-echo%",
                    "later n", "later outlier%", "later no-echo%")


def handover_cells(stat):
    return [stat.node, str(stat.off_turn), str(stat.early_n), _fmt(stat.early_outlier_pct),
            _fmt(stat.early_no_echo_pct), str(stat.late_n), _fmt(stat.late_outlier_pct),
            _fmt(stat.late_no_echo_pct)]


def report(path, outlier_cm=DEFAULT_OUTLIER_CM, csv_out=None, out=print):
    rows = read_recording(path)
    labelled = [row for row in rows if row.label]
    name = os.path.basename(path)
    if not labelled:
        out(f"No labelled readings in {name}: record the steps with `bench_noise.py capture`.")
        return 1

    stats = summarise(labelled, outlier_cm)
    out(f"{name}: {len(labelled)} labelled readings of {len(rows)}. "
        f"Distances in cm; an outlier is more than {outlier_cm:g} cm from the step's median.")
    out("sigma = 1.4826 x MAD (ignores outliers); std includes them; "
        "bias = median - the distance in the step's label.")
    out("")
    out(format_table(STATS_HEADERS, [stats_cells(stat) for stat in stats], text_columns=4))
    out("")
    out(f"Scan-turn hand-over ({HANDOVER_SIGNAL}): 'early' is the first "
        f"{HANDOVER_WINDOW_MS:.0f} ms after a node was given the turn, when the other "
        "node may still be pinging. 'off-turn' readings arrived without the turn.")
    out(format_table(HANDOVER_HEADERS, [handover_cells(stat) for stat in handover(labelled, outlier_cm)],
                     text_columns=1))

    if csv_out:
        with open(csv_out, "w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(STATS_HEADERS)
            writer.writerows(stats_cells(stat) for stat in stats)
        out(f"\nWrote {csv_out}")
    return 0


# --- Capture --------------------------------------------------------------------

def post_json(url, body, timeout=5):
    """POST a JSON body; (status, reply as a dict). Raises URLError if the
    server cannot be reached."""
    request = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    try:
        reply = json.loads(raw or b"{}")
    except json.JSONDecodeError:
        reply = {}
    return status, reply if isinstance(reply, dict) else {}


def step_label(pulses, distance_cm):
    return f"p{pulses}-{distance_cm:g}cm"


def capture(server, distances, pulses_list, seconds, settle_s,
            post=post_json, prompt=input, sleep=time.sleep, out=print):
    label_url = f"{server}/api/recording/label"
    pulses_url = f"{server}/api/pulses"

    try:
        status, reply = post(label_url, {"label": ""})
    except urllib.error.URLError as error:
        out(f"Cannot reach the server at {server}: {error.reason}. Is app.py running?")
        return 1
    if status == 404:
        out("The server is not recording. Restart it with REC=1:  REC=1 python Website/app.py")
        return 1
    if status != 200:
        out(f"The server answered {status}: {reply.get('error', '')}")
        return 1

    recording = reply.get("file", "")
    out(f"Recording to logs/{recording}.")
    out("Keep the game page closed, or at least off the calibration screen: it holds the "
        "servos still, and multi-pulse does nothing while they are held. Don't press the "
        "game's Pulses button during the test.")
    try:
        for pulses in pulses_list:
            status, reply = post(pulses_url, {"count": pulses})
            if status != 200:
                out(f"The server refused Pulses {pulses}: {reply.get('error', status)}")
                return 1
            for distance in distances:
                label = step_label(pulses, distance)
                prompt(f"[{label}] Put the target {distance:g} cm in front of both nodes, "
                       "then press Enter: ")
                sleep(settle_s)             # let the scan find the target first
                post(label_url, {"label": label})
                out(f"  recording {label} for {seconds:g} s ...")
                sleep(seconds)
                post(label_url, {"label": ""})
    except KeyboardInterrupt:
        out("\nStopped. The steps finished so far are in the recording.")
    except urllib.error.URLError as error:
        out(f"Lost the server at {server}: {error.reason}. "
            "The steps finished so far are in the recording.")
        return 1
    finally:
        # No label (the target is not in place any more) and Pulses back to off.
        try:
            post(label_url, {"label": ""})
            post(pulses_url, {"count": 1})
        except urllib.error.URLError:
            pass
    out("Pulses is back to Off. Now run:")
    out(f"  python Website/tools/bench_noise.py report logs/{recording}")
    return 0


# --- Command line ---------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0].strip(),
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)

    capture_parser = commands.add_parser("capture", help="record labelled bench steps")
    capture_parser.add_argument("--distances", type=float, nargs="+", default=[30, 60, 90, 120],
                                help="target distances in cm (default: 30 60 90 120)")
    capture_parser.add_argument("--pulses", type=int, nargs="+", default=[1, 3], choices=[1, 2, 3],
                                help="Pulses settings to compare (default: 1 3)")
    capture_parser.add_argument("--seconds", type=float, default=20,
                                help="how long each step records (default: 20)")
    capture_parser.add_argument("--settle", type=float, default=2,
                                help="seconds after Enter before recording, so the scan "
                                     "finds the target (default: 2)")
    capture_parser.add_argument("--server", default=DEFAULT_SERVER,
                                help=f"the Flask server (default: {DEFAULT_SERVER})")

    report_parser = commands.add_parser("report", help="noise numbers for a recording")
    report_parser.add_argument("recording", help="a logs/raw-*.csv file")
    report_parser.add_argument("--outlier-cm", type=float, default=DEFAULT_OUTLIER_CM,
                               help=f"outlier threshold (default: {DEFAULT_OUTLIER_CM:g})")
    report_parser.add_argument("--csv", help="also write the table to this CSV file")

    args = parser.parse_args(argv)
    if args.command == "capture":
        return capture(args.server.rstrip("/"), args.distances, args.pulses, args.seconds,
                       args.settle)
    return report(args.recording, args.outlier_cm, args.csv)


if __name__ == "__main__":
    sys.exit(main())
