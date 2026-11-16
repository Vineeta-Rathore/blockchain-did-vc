"""Figure 3: local in-process verification on 9 November 2026, drawn only from logged measurements.

Input: the local log results/local_2026-11-09_n100.jsonl of this repository (its SHA-256 is checked; it is the
value given in the paper's Data Availability Statement). The script reads no other file.
Only the 100 timed rows are used (kind == "local", warmup is False). No value is generated, smoothed or jittered.
Panel (a): every logged total_ms as one point, over a box plot. Horizontal positions are fixed offsets from each
point's rank (a golden-ratio sequence, as in scripts/plot-latency.py); they only separate the
points on a categorical axis and carry no value. Box: type 7 quartiles; whiskers at the most extreme values within
1.5 times the interquartile range; p95 by nearest rank.
Panel (b): per-step median and interquartile range (type 7) over the same 100 verifications.

The statistics drawn are written to Figure_3_stats.json and compared with the values of the submitted figure,
which are written below (EXPECTED); any mismatch stops the build.

Text is set by pdflatex through Matplotlib's pgf backend with mathptmx (Times), the manuscript's body font, so
the PDF embeds Type 1 fonts. pdflatex must be on PATH. The figure is drawn at its printed width (main.tex:
0.82\\columnwidth = 413.70 TeX pt), so it is placed at scale 1.0.

Usage, from the repository root: python3 figures/gen_fig_3.py [--out-dir DIR]   (default: figures/out)
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path

import matplotlib

matplotlib.use("pgf")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
LOCAL_LOG = ROOT / "results" / "local_2026-11-09_n100.jsonl"
LOCAL_SHA = "a6a5480b34c934d09ea233954d4be4cf9b28c9e723470f181a9b64e0b8e8a385"
DEFAULT_OUT = HERE / "out"

# The statistics of the submitted Figure 3 (its Figure_3_stats.json), as computed from the log above.
EXPECTED = {
    "total_ms": {"n": 100, "q1": 2.608775, "median": 2.76645, "q3": 3.1668250000000002, "whiskerLow": 2.1193,
                 "whiskerHigh": 3.8235, "p95NearestRank": 3.8235, "min": 2.1193, "max": 5.0322,
                 "mean": 2.9247140000000003, "beyondWhiskers": 5},
    "steps_ms": {
        "V1": {"q1": 0.0108, "median": 0.01185, "q3": 0.0137},
        "B0": {"q1": 0.08637500000000001, "median": 0.0939, "q3": 0.1072},
        "V2": {"q1": 0.355275, "median": 0.38165000000000004, "q3": 0.42662500000000003},
        "V3": {"q1": 0.353225, "median": 0.389, "q3": 0.48807500000000004},
        "V4": {"q1": 0.003175, "median": 0.00385, "q3": 0.0044},
        "V5": {"q1": 0.832325, "median": 0.95915, "q3": 1.0399},
        "V6": {"q1": 0.3317, "median": 0.35745, "q3": 0.40395},
        "V7": {"q1": 0.45404999999999995, "median": 0.509, "q3": 0.601025},
        "V8": {"q1": 0.0008, "median": 0.0009, "q3": 0.0011},
    },
}

# Step names as in the enumerated list of main.tex (Credential Verification Pipeline).
STEPS = [("V1", "V1 Structure and dates"), ("B0", "B0 Select block"), ("V2", "V2 Issuer DID liveness"),
         ("V3", "V3 Subject DID liveness"), ("V4", "V4 Validity window"), ("V5", "V5 Key resolution"),
         ("V6", "V6 Signature verification"), ("V7", "V7 Revocation check"), ("V8", "V8 Accept")]
NODE_STEPS = {"B0", "V2", "V3", "V5", "V7"}  # steps that send a request to the node (verifier-service.js)

# Okabe-Ito
BLUE, ORANGE, BLACK = "#0072B2", "#E69F00", "#000000"
GREY, GRID = "#4D4D4D", "#D9D9D9"
GOLDEN = (math.sqrt(5) - 1) / 2
TEXT_PT = 504.50787 * 0.82          # printed width in TeX points
WIDTH_IN = TEXT_PT / 72.27
HEIGHT_IN = 2.55


def q7(s, p):
    h = (len(s) - 1) * p
    lo = math.floor(h)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (h - lo) * (s[hi] - s[lo])


def nearest_rank(s, p):
    return s[max(1, math.ceil(p * len(s))) - 1]


def box_stats(values):
    s = sorted(values)
    q1, med, q3 = (q7(s, p) for p in (0.25, 0.5, 0.75))
    iqr = q3 - q1
    low = min(v for v in s if v >= q1 - 1.5 * iqr)
    high = max(v for v in s if v <= q3 + 1.5 * iqr)
    return {"n": len(s), "q1": q1, "median": med, "q3": q3, "whiskerLow": low, "whiskerHigh": high,
            "p95NearestRank": nearest_rank(s, 0.95), "min": s[0], "max": s[-1], "mean": sum(s) / len(s),
            "beyondWhiskers": sum(1 for v in s if v < low or v > high)}


def read_rows():
    data = LOCAL_LOG.read_bytes()
    if hashlib.sha256(data).hexdigest() != LOCAL_SHA:
        raise SystemExit("The local log differs from the published file (SHA-256 mismatch).")
    rows = []
    for number, line in enumerate(data.decode("utf-8").splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("kind") == "local" and row.get("warmup") is False:
            rows.append((number, row))
    if len(rows) != 100 or any(r.get("valid") is not True for _, r in rows):
        raise SystemExit("Figure 3 requires exactly 100 valid timed rows.")
    if any(not all(isinstance(r.get("steps", {}).get(k), (int, float)) for k, _ in STEPS) for _, r in rows):
        raise SystemExit("A timed row lacks a step time.")
    return rows


def cross_check(stats, steps):
    old = EXPECTED
    if set(old["total_ms"]) != set(stats):
        raise SystemExit("The statistics differ in their fields from the submitted figure.")
    for k, v in stats.items():
        if not math.isclose(old["total_ms"][k], v, rel_tol=0, abs_tol=1e-12):
            raise SystemExit(f"total_ms {k} differs from the saved statistics.")
    for k, _ in STEPS:
        for q in ("q1", "median", "q3"):
            if not math.isclose(old["steps_ms"][k][q], steps[k][q], rel_tol=0, abs_tol=1e-12):
                raise SystemExit(f"step {k} {q} differs from the saved statistics.")


def style(ax):
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_linewidth(0.6)
        ax.spines[side].set_color(BLACK)
    ax.tick_params(width=0.6, length=2.5, colors=BLACK, labelsize=7.5, pad=2)
    ax.set_axisbelow(True)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT))
    out = Path(parser.parse_args().out_dir).resolve()
    if out in (HERE, ROOT, LOCAL_LOG.parent):
        raise SystemExit("Choose an output folder that holds no input (default: figures/out).")
    # Fixed, so that the PDF does not depend on the environment (1 January 2026, 00:00 UTC).
    os.environ["SOURCE_DATE_EPOCH"] = "1767225600"
    os.environ["FORCE_SOURCE_DATE"] = "1"

    rows = read_rows()
    totals = [r["total_ms"] for _, r in rows]
    stats = box_stats(totals)
    steps = {}
    for k, _ in STEPS:
        s = sorted(r["steps"][k] for _, r in rows)
        steps[k] = {"q1": q7(s, 0.25), "median": q7(s, 0.5), "q3": q7(s, 0.75)}
    cross_check(stats, steps)

    matplotlib.rcParams.update({
        "pgf.texsystem": "pdflatex",
        "pgf.rcfonts": False,
        "pgf.preamble": "\n".join([r"\usepackage[T1]{fontenc}", r"\usepackage{mathptmx}",
                                   r"\pdfinfoomitdate=1", r"\pdftrailerid{}", r"\pdfsuppressptexinfo=-1"]),
        "font.family": "serif",
        "font.size": 8,
        "axes.labelsize": 8,
        "axes.titlesize": 8,
        "legend.fontsize": 7.5,
        "text.color": BLACK,
        "axes.labelcolor": BLACK,
    })
    fig, (ax_a, ax_b) = plt.subplots(1, 2, figsize=(WIDTH_IN, HEIGHT_IN),
                                     gridspec_kw={"width_ratios": [0.80, 1.45]})
    for ax in (ax_a, ax_b):
        style(ax)

    # (a) every logged verification
    order = sorted(range(len(totals)), key=lambda i: totals[i])
    xs = [0.0] * len(totals)
    for rank, i in enumerate(order):
        xs[i] = 1 + 0.30 * (((rank + 1) * GOLDEN) % 1 - 0.5)
    ax_a.scatter(xs, totals, s=9, facecolors="none", edgecolors=BLUE, linewidths=0.55, zorder=2)
    ax_a.bxp([{"q1": stats["q1"], "med": stats["median"], "q3": stats["q3"], "whislo": stats["whiskerLow"],
               "whishi": stats["whiskerHigh"], "fliers": []}],
             positions=[1], widths=0.44, showfliers=False, patch_artist=True, zorder=3,
             boxprops={"facecolor": "none", "edgecolor": BLACK, "linewidth": 0.7},
             medianprops={"color": BLACK, "linewidth": 1.5},
             whiskerprops={"color": BLACK, "linewidth": 0.7},
             capprops={"color": BLACK, "linewidth": 0.7})
    ax_a.annotate(f"median {stats['median']:.2f} ms", xy=(1.23, stats["median"]), xytext=(1.30, stats["median"]),
                  va="center", fontsize=7.5, arrowprops={"arrowstyle": "-", "linewidth": 0.5, "color": BLACK})
    ax_a.annotate(f"p95 {stats['p95NearestRank']:.2f} ms", xy=(1.13, stats["p95NearestRank"]),
                  xytext=(1.30, stats["p95NearestRank"]), va="center", fontsize=7.5,
                  arrowprops={"arrowstyle": "-", "linewidth": 0.5, "color": BLACK})
    processes = len({r["process"] for _, r in rows})
    ax_a.set_xticks([1])
    ax_a.set_xticklabels([rf"\textit{{n}} = {stats['n']}" + "\n" + rf"({processes} processes $\times$ {stats['n'] // processes})"])
    ax_a.tick_params(axis="x", length=0)
    ax_a.set_xlim(0.62, 1.95)
    ax_a.set_ylim(0, 5.5)
    ax_a.set_yticks([0, 1, 2, 3, 4, 5])
    ax_a.set_ylabel("End-to-end verification time (ms)")
    ax_a.yaxis.grid(True, color=GRID, linewidth=0.4)
    ax_a.set_title(r"\textbf{(a)} All 100 verifications", loc="left", pad=4)

    # (b) per step
    for idx, (k, _) in enumerate(STEPS):
        y = len(STEPS) - 1 - idx
        node = k in NODE_STEPS
        colour = BLUE if node else ORANGE
        st = steps[k]
        ax_b.plot([st["q1"], st["q3"]], [y, y], color=colour, linewidth=1.4, solid_capstyle="butt", zorder=2)
        ax_b.plot([st["median"]], [y], marker="o" if node else "s", markersize=4.2, color=colour,
                  markeredgecolor=BLACK, markeredgewidth=0.5, linestyle="none", zorder=3)
        ax_b.text(max(st["q3"], st["median"]) + 0.025, y, f"{st['median']:.3f}", va="center", fontsize=7)
    ax_b.set_yticks(range(len(STEPS)))
    ax_b.set_yticklabels([label for _, label in reversed(STEPS)])
    ax_b.tick_params(axis="y", length=0)
    ax_b.set_ylim(-0.6, len(STEPS) - 0.4)
    ax_b.set_xlim(0, 1.2)
    ax_b.set_xticks([0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2])
    ax_b.set_xlabel("Step time (ms): median and interquartile range")
    ax_b.xaxis.grid(True, color=GRID, linewidth=0.4)
    ax_b.set_title(r"\textbf{(b)} Per step, same 100 verifications", loc="left", pad=4)
    handles = [Line2D([0], [0], marker="o", color=BLUE, linewidth=1.4, markersize=4.2, markeredgecolor=BLACK,
                      markeredgewidth=0.5, label="request to the node"),
               Line2D([0], [0], marker="s", color=ORANGE, linewidth=1.4, markersize=4.2, markeredgecolor=BLACK,
                      markeredgewidth=0.5, label="computed in the verifier")]
    ax_b.legend(handles=handles, loc="upper right", frameon=False, handlelength=1.8, borderaxespad=0.2)

    fig.tight_layout(pad=0.3, w_pad=1.2)
    out.mkdir(parents=True, exist_ok=True)
    fig.savefig(out / "Figure_3.pdf", metadata={"CreationDate": None, "ModDate": None, "Producer": None,
                                                 "Creator": None})
    (out / "Figure_3_stats.json").write_text(json.dumps({"log": LOCAL_LOG.name, "log_sha256": LOCAL_SHA,
                                                         "total_ms": stats, "steps_ms": steps}, indent=2) + "\n",
                                             encoding="utf-8", newline="\n")
    print(json.dumps({"n": stats["n"], "median": stats["median"], "p95": stats["p95NearestRank"]}))


if __name__ == "__main__":
    main()
