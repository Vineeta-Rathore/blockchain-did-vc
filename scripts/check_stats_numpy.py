"""Cross-check scripts/lib/stats.js against numpy (SOP gate).

median: np.median; Q1 and Q3: np.percentile default ("linear", Hyndman and Fan type 7);
p95: np.percentile(method="inverted_cdf"), the nearest-rank definition.
Vectors: the July 2026 log, odd n, even n, ties, a single value, and a seeded n = 100 sample.

Run from the artifact root:  python scripts/check_stats_numpy.py
"""
import json
import subprocess
import sys

import numpy as np

july = [json.loads(line) for line in open("results/sepolia_2026-07-21_n20.jsonl", encoding="utf-8") if line.strip()]
run1 = next(r for r in july if r["kind"] == "latency")
run2 = next(r for r in july if r["kind"] == "latency_parallel")
rng = np.random.default_rng(20261108)
vectors = {
    "july_run1_sequential": run1["totals"],
    "july_run2_sequential": run2["sequential"],
    "july_run2_parallel": run2["parallel"],
    "odd_n": [5.0, 1.0, 3.0, 2.0, 4.0, 9.0, 7.0],
    "even_n": [4.0, 1.0, 3.0, 2.0],
    "ties": [1.0, 1.0, 2.0, 2.0, 2.0, 3.0, 3.0, 10.0],
    "single": [42.0],
    "seeded_n100": [float(v) for v in rng.lognormal(mean=4.0, sigma=0.3, size=100)],
}

js = (
    "const S=require('./scripts/lib/stats');const v=JSON.parse(require('fs').readFileSync(0,'utf8'));"
    "const o={};for(const[k,x]of Object.entries(v)){o[k]={median:S.median(x),q1:S.quantileType7(x,0.25),"
    "q3:S.quantileType7(x,0.75),p95:S.nearestRank(x,0.95)};}process.stdout.write(JSON.stringify(o));"
)
res = subprocess.run(["node", "-e", js], input=json.dumps(vectors), capture_output=True, text=True, check=True)
got = json.loads(res.stdout)

failures = 0
for name, x in vectors.items():
    a = np.asarray(x, dtype=float)
    expected = {
        "median": float(np.median(a)),
        "q1": float(np.percentile(a, 25)),
        "q3": float(np.percentile(a, 75)),
        "p95": float(np.percentile(a, 95, method="inverted_cdf")),
    }
    for stat, value in expected.items():
        if abs(got[name][stat] - value) > 1e-9 * max(1.0, abs(value)):
            failures += 1
            print(f"MISMATCH {name} {stat}: js={got[name][stat]} numpy={value}")
print(f"numpy {np.__version__}: {len(vectors)} vectors x 4 statistics, {failures} mismatches")
sys.exit(1 if failures else 0)
