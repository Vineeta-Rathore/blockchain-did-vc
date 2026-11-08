#!/usr/bin/env python3
"""Latency figure from a log of scripts/measure-local.js (full verification on the Hardhat network).

Panel (a): one point per timed verification of the log (warm-up rows are left out), over a box plot. Points get fixed
horizontal offsets computed from their rank (a golden-ratio sequence), so the same log always gives the same figure.
Box: first quartile, median and third quartile by the Hyndman and Fan type 7 rule, as in scripts/lib/stats.js;
whiskers reach the most extreme values that lie within 1.5 times the interquartile range of the box. The 95th
percentile (nearest rank) is marked and labelled.
Panel (b): for each step of the verifier, the median duration and the interquartile range over the same
verifications. Steps that send a request to the node (B0, V2, V3, V5, V7) and steps computed in the verifier (V1, V4,
V6, V8) differ in colour and marker shape.

Prints the statistics it drew as JSON, so they can be compared with scripts/analyze-latency.js.

  python scripts/plot-latency.py results/local_<date>_n100.jsonl --out <figure.pdf> [--out <figure.png>]
         [--expect-n 100] [--panels total,steps]
"""
import argparse
import json
import math
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402

STEPS = [
    ("V1", "V1 structure and dates"),
    ("B0", "B0 block number"),
    ("V2", "V2 issuer DID"),
    ("V3", "V3 subject DID"),
    ("V4", "V4 validity period"),
    ("V5", "V5 issuer document"),
    ("V6", "V6 proof"),
    ("V7", "V7 revocation"),
    ("V8", "V8 accept"),
]
NODE_STEPS = {"B0", "V2", "V3", "V5", "V7"}

INK = "#0b0b0b"
INK_SECONDARY = "#52514e"
MUTED = "#898781"
GRID = "#e1e0d9"
AXIS = "#c3c2b7"
SERIES_1 = "#2a78d6"
SERIES_2 = "#eb6834"
SURFACE = "#ffffff"
GOLDEN = (math.sqrt(5) - 1) / 2


def quantile_type7(sorted_values, p):
    """Hyndman and Fan type 7 (numpy's default), same as quantileType7 in scripts/lib/stats.js."""
    n = len(sorted_values)
    h = (n - 1) * p
    lo = math.floor(h)
    hi = min(lo + 1, n - 1)
    return sorted_values[lo] + (h - lo) * (sorted_values[hi] - sorted_values[lo])


def nearest_rank(sorted_values, p):
    """Nearest-rank percentile, same as nearestRank in scripts/lib/stats.js."""
    n = len(sorted_values)
    return sorted_values[max(1, math.ceil(p * n)) - 1]


def box_stats(values):
    s = sorted(values)
    q1, med, q3 = (quantile_type7(s, p) for p in (0.25, 0.5, 0.75))
    iqr = q3 - q1
    low = min(v for v in s if v >= q1 - 1.5 * iqr)
    high = max(v for v in s if v <= q3 + 1.5 * iqr)
    return {"n": len(s), "q1": q1, "median": med, "q3": q3, "whiskerLow": low, "whiskerHigh": high,
            "p95NearestRank": nearest_rank(s, 0.95), "min": s[0], "max": s[-1], "mean": sum(s) / len(s),
            "beyondWhiskers": sum(1 for v in s if v < low or v > high)}


def read_log(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for number, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                sys.exit(f"line {number} of the log is not JSON")
            if row.get("kind") == "local" and not row.get("warmup"):
                rows.append(row)
    return rows


def panel_total(ax, rows, stats):
    values = [r["total_ms"] for r in rows]
    order = sorted(range(len(values)), key=lambda i: values[i])
    xs = [0.0] * len(values)
    for rank, i in enumerate(order):
        xs[i] = 1 + 0.34 * (((rank + 1) * GOLDEN) % 1 - 0.5)
    ax.scatter(xs, values, s=11, color=SERIES_1, alpha=0.75, edgecolors=SURFACE, linewidths=0.4, zorder=2)
    ax.bxp([{"q1": stats["q1"], "med": stats["median"], "q3": stats["q3"], "whislo": stats["whiskerLow"],
             "whishi": stats["whiskerHigh"], "fliers": []}],
           positions=[1], widths=0.5, showfliers=False, patch_artist=True, zorder=3,
           boxprops={"facecolor": "none", "edgecolor": INK_SECONDARY, "linewidth": 0.9},
           medianprops={"color": INK, "linewidth": 1.6},
           whiskerprops={"color": INK_SECONDARY, "linewidth": 0.9},
           capprops={"color": INK_SECONDARY, "linewidth": 0.9})
    ax.plot([1.29, 1.37], [stats["p95NearestRank"]] * 2, color=INK_SECONDARY, linewidth=0.9, zorder=3)
    ax.annotate(f"median {stats['median']:.2f} ms", xy=(1.27, stats["median"]), xytext=(1.42, stats["median"]),
                va="center", fontsize=7.5, color=INK)
    ax.annotate(f"95th percentile {stats['p95NearestRank']:.2f} ms", xy=(1.37, stats["p95NearestRank"]),
                xytext=(1.42, stats["p95NearestRank"]), va="center", fontsize=7.5, color=INK_SECONDARY)
    processes = len({r.get("process") for r in rows})
    per_process = stats["n"] // processes if processes else stats["n"]
    ax.set_xticks([1])
    ax.set_xticklabels([f"n = {stats['n']} verifications\n({processes} processes × {per_process})"])
    ax.set_xlim(0.55, 2.35)
    top = stats["max"] * 1.06
    ax.set_ylim(0, top)
    ax.set_ylabel("Verification time (ms)")
    ax.set_title("(a) Full verification", loc="left", fontsize=8.5, color=INK)
    ax.yaxis.grid(True, color=GRID, linewidth=0.5)


def panel_steps(ax, rows):
    out = {}
    labels = []
    for k, (key, label) in enumerate(STEPS):
        s = sorted(r["steps"][key] for r in rows)
        q1, med, q3 = (quantile_type7(s, p) for p in (0.25, 0.5, 0.75))
        out[key] = {"q1": q1, "median": med, "q3": q3}
        y = len(STEPS) - 1 - k
        node = key in NODE_STEPS
        color = SERIES_1 if node else SERIES_2
        ax.plot([q1, q3], [y, y], color=color, linewidth=1.6, solid_capstyle="round", zorder=2)
        ax.scatter([med], [y], s=26, color=color, marker="o" if node else "s", edgecolors=SURFACE, linewidths=0.6,
                   zorder=3)
        labels.append(label)
    ax.set_yticks(range(len(STEPS)))
    ax.set_yticklabels(list(reversed(labels)))
    ax.set_xlim(left=0)
    ax.set_xlabel("Step duration (ms), median and interquartile range")
    ax.set_title("(b) Per step", loc="left", fontsize=8.5, color=INK)
    ax.xaxis.grid(True, color=GRID, linewidth=0.5)
    handles = [Line2D([0], [0], marker="o", color=SERIES_1, linewidth=1.6, markersize=4.5,
                      markeredgecolor=SURFACE, label="request to the node"),
               Line2D([0], [0], marker="s", color=SERIES_2, linewidth=1.6, markersize=4.5,
                      markeredgecolor=SURFACE, label="computed in the verifier")]
    ax.legend(handles=handles, loc="upper right", fontsize=7, frameon=False, labelcolor=INK_SECONDARY)
    return out


def style(ax):
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(AXIS)
        ax.spines[side].set_linewidth(0.8)
    ax.tick_params(colors=MUTED, labelcolor=INK_SECONDARY, labelsize=7.5, width=0.6)
    ax.set_axisbelow(True)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("log")
    parser.add_argument("--out", action="append", required=True, help=".pdf, .eps or .png; may be repeated")
    parser.add_argument("--expect-n", type=int)
    parser.add_argument("--panels", default="total,steps")
    args = parser.parse_args()

    rows = read_log(args.log)
    if not rows:
        sys.exit("no timed rows in the log")
    if any(not r.get("valid") for r in rows):
        sys.exit("the log contains verifications that did not return VALID")
    if args.expect_n is not None and len(rows) != args.expect_n:
        sys.exit(f"expected {args.expect_n} timed rows, found {len(rows)}")
    panels = [p.strip() for p in args.panels.split(",") if p.strip()]

    matplotlib.rcParams.update({
        "font.family": "sans-serif",
        "font.sans-serif": ["Arial", "Liberation Sans", "DejaVu Sans"],
        "font.size": 8,
        "axes.labelsize": 8,
        "axes.labelcolor": INK_SECONDARY,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
        "svg.hashsalt": "plot-latency",
    })
    os.environ.setdefault("SOURCE_DATE_EPOCH", "1767225600")  # fixed creation date for EPS output
    widths = {"total": 1.0, "steps": 1.35}
    fig, axes = plt.subplots(1, len(panels), figsize=(6.85 if len(panels) > 1 else 3.3, 2.9),
                             gridspec_kw={"width_ratios": [widths[p] for p in panels]})
    axes = axes if len(panels) > 1 else [axes]
    stats = box_stats([r["total_ms"] for r in rows])
    result = {"log": os.path.basename(args.log), "total_ms": stats}
    for ax, name in zip(axes, panels):
        style(ax)
        if name == "total":
            panel_total(ax, rows, stats)
        elif name == "steps":
            result["steps_ms"] = panel_steps(ax, rows)
        else:
            sys.exit(f"unknown panel {name}")
    fig.tight_layout(w_pad=2.0)
    for out in args.out:
        if out.lower().endswith(".pdf"):
            fig.savefig(out, metadata={"CreationDate": None, "ModDate": None})
        elif out.lower().endswith(".png"):
            fig.savefig(out, dpi=300)
        else:
            fig.savefig(out)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
