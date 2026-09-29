"""
compare_chains.py - replay one logged session through the V1 and V2 chains.

    python Website/tools/compare_chains.py SESSION.csv --out OUTSIDE/compare.png
    python Website/tools/compare_chains.py SESSION.csv --no-plot

SESSION.csv is a simple reading CSV (t_s, sensor, raw_cm) or a Sprint 1 game
log CSV; see session_readers.py. Prints, per chain, the count of cursor-cell
changes and alarm (too-close) episodes, and plots distance against time per
sensor: raw readings, V1 output, V2 output and the V2 prediction.

V1 is the browser chain as it ran (the rules once per animation frame, each
frame re-seeing the latest reading); V2 is serverFilter.py (once per fresh
reading) with tracking.py's predictor. See chain_replay.py.

There is no default output path: pass --out, and keep it outside the repo.
The plot needs matplotlib, which the server does not; it is imported only
when a plot is asked for.
"""

from __future__ import annotations

import argparse
import math
import os
import sys

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
if TOOLS_DIR not in sys.path:
    sys.path.insert(0, TOOLS_DIR)

from chain_replay import (  # noqa: E402
    DEFAULT_V1_FRAME_HZ,
    DEFAULT_V1_FRAME_PHASE_MS,
    area_for,
    count_alarm_episodes,
    count_cell_changes,
    replay_v1,
    replay_v2,
)
from session_readers import SLOT_NAMES, read_session  # noqa: E402

MS_PER_SECOND = 1000.0

# Figure size, inches: one row per sensor, wide enough to read a minute of play.
FIGURE_WIDTH_IN = 11.0
FIGURE_ROW_HEIGHT_IN = 2.6
FIGURE_DPI = 150

RAW_MARKER_SIZE_PT = 2.0


def parse_per_column(text: str) -> tuple:
    """'near,far near,far near,far' in cm -> ((near, far), ...)."""
    pairs = []
    for chunk in text.split():
        near, far = (float(v) for v in chunk.split(","))
        pairs.append((near, far))
    if len(pairs) != len(SLOT_NAMES):
        raise ValueError(f"need {len(SLOT_NAMES)} near,far pairs, got {len(pairs)}")
    return tuple(pairs)


def summarise(session, v1, v2, area) -> dict:
    return {
        "source": session.source,
        "duration_s": session.duration_s,
        "readings": session.count_per_slot(),
        "no_echo": session.no_echo_per_slot(),
        "calibrated": area.is_calibrated,
        "alert_threshold_cm": area.alert_threshold_cm,
        "notes": list(session.notes),
        "chains": {
            trace.name: {
                "steps": len(trace.t_ms),
                "cell_changes": count_cell_changes(trace.cell),
                "alarm_episodes": count_alarm_episodes(trace.status),
                "slew_rejects": list(trace.rejected),
            }
            for trace in (v1, v2)
        },
    }


def format_summary(summary: dict) -> str:
    lines = [
        f"session: {summary['source']}  ({summary['duration_s']:.1f} s)",
        "readings per sensor (L, C, R): " + ", ".join(map(str, summary["readings"]))
        + "   no echo: " + ", ".join(map(str, summary["no_echo"])),
        f"play area: {'calibrated' if summary['calibrated'] else 'default'}, "
        f"alert below {summary['alert_threshold_cm']:.1f} cm",
    ]
    lines += [f"note: {note}" for note in summary["notes"]]
    lines.append(f"{'chain':<6}{'steps':>9}{'cell changes':>15}{'alarm episodes':>17}{'slew rejects (L,C,R)':>24}")
    for name, c in summary["chains"].items():
        rejects = ",".join(map(str, c["slew_rejects"]))
        lines.append(f"{name:<6}{c['steps']:>9}{c['cell_changes']:>15}{c['alarm_episodes']:>17}{rejects:>24}")
    return "\n".join(lines)


def _series(trace_values, slot):
    return [math.nan if step[slot] is None else step[slot] for step in trace_values]


def plot(session, v1, v2, summary, out_path) -> None:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        raise SystemExit("compare_chains: the plot needs matplotlib, which is not "
                         "installed (pip install matplotlib), or run with --no-plot")

    fig, axes = plt.subplots(len(SLOT_NAMES), 1, sharex=True,
                             figsize=(FIGURE_WIDTH_IN, FIGURE_ROW_HEIGHT_IN * len(SLOT_NAMES)))
    t0_ms = session.readings[0].t_ms if session.readings else 0.0

    def seconds(times_ms):
        return [(t - t0_ms) / MS_PER_SECOND for t in times_ms]

    for slot, ax in enumerate(axes):
        raw = [r for r in session.readings if r.slot == slot and r.distance_cm is not None]
        ax.plot(seconds([r.t_ms for r in raw]), [r.distance_cm for r in raw], ".",
                color="0.55", markersize=RAW_MARKER_SIZE_PT, label="raw")
        ax.plot(seconds(v1.t_ms), _series(v1.filtered_cm, slot), drawstyle="steps-post",
                linewidth=1.0, label="V1 output (per frame)")
        ax.plot(seconds(v2.t_ms), _series(v2.filtered_cm, slot), drawstyle="steps-post",
                linewidth=1.0, label="V2 output (per reading)")
        ax.plot(seconds(v2.t_ms), _series(v2.predicted_cm, slot), "--",
                linewidth=0.8, label="V2 prediction")
        ax.axhline(summary["alert_threshold_cm"], color="tab:red", linewidth=0.6,
                   linestyle=":", label="alert threshold")
        ax.set_ylabel(f"{SLOT_NAMES[slot]} (cm)")
        ax.grid(True, linewidth=0.3)
    axes[0].legend(loc="upper right", fontsize=7, ncol=5)
    axes[-1].set_xlabel("time since first reading (s)")

    chains = summary["chains"]
    fig.suptitle(
        f"{summary['source']}: "
        f"V1 {chains['V1']['cell_changes']} cell changes, {chains['V1']['alarm_episodes']} alarm episodes; "
        f"V2 {chains['V2']['cell_changes']} cell changes, {chains['V2']['alarm_episodes']} alarm episodes",
        fontsize=9)
    fig.tight_layout()
    fig.savefig(out_path, dpi=FIGURE_DPI)
    plt.close(fig)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Replay one session of raw readings through the V1 and V2 chains.")
    parser.add_argument("session", help="simple reading CSV or Sprint 1 game log CSV")
    parser.add_argument("--out", help="PNG to write (no default; keep it outside the repo)")
    parser.add_argument("--no-plot", action="store_true", help="print the counts only")
    parser.add_argument("--frame-hz", type=float, default=DEFAULT_V1_FRAME_HZ,
                        help=f"V1 animation frame rate, Hz (default {DEFAULT_V1_FRAME_HZ:g})")
    parser.add_argument("--frame-phase-ms", type=float, default=DEFAULT_V1_FRAME_PHASE_MS,
                        help="first V1 frame after the first reading, ms")
    parser.add_argument("--per-column", type=parse_per_column, default=None,
                        help="calibration as 'near,far near,far near,far' in cm "
                             "(overrides a game log's own)")
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.no_plot and not args.out:
        parser.error("--out is required unless --no-plot is given")

    session = read_session(args.session)
    if not session.readings:
        parser.error(f"{session.source}: no readings")
    area = area_for(args.per_column or session.per_column)
    v1 = replay_v1(session.readings, area, args.frame_hz, args.frame_phase_ms)
    v2 = replay_v2(session.readings, area)
    summary = summarise(session, v1, v2, area)
    print(format_summary(summary))
    if not args.no_plot:
        plot(session, v1, v2, summary, args.out)
        print(f"plot written: {os.path.basename(args.out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
