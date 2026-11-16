#!/usr/bin/env python3
"""Sanitised summary of the network monitor of the 12 November 2026 Sepolia run.

The wrapper (run_day/start_sepolia_run.ps1) wrote one monitor tick a minute to run_monitor.jsonl. That raw file stays
with the authors: its fields gw, net and saltId are salted hashes of the default gateway and of the network name, w and
wid identify the wrapper process, and ifaces names the network adapters. This script reads the raw file and writes
counts and times only. It copies no value of gw, net, saltId, w, wid or ifaces; it only compares them, as the checker
(run_day/check_sepolia_run.js, monitorIssues) does.

Block windows follow the checker: [start - 90 s, start + 120 s], where the start is the "at" time of the block's
cold-start row in the Sepolia log. A tick with a gap over 90 s counts for a window if the interval it covers touches it.

Offline. Reads only the two files named on the command line and writes only the files given with --out and --md.

  python3 results/run_2026-11-12/make_monitor_summary.py <run_monitor.jsonl> <sepolia log.jsonl>
          [--out monitor_summary.json] [--md monitor_summary.md]
"""
import argparse
import datetime as dt
import hashlib
import json
import statistics
import sys
from pathlib import Path

GAP_S = 90
LOOKBACK_S = 90
LOOKAHEAD_S = 120
NOTE_CPU_PCT = 25
NOTE_RX_BYTES = 1000000
IST = dt.timezone(dt.timedelta(minutes=330))


def parse_time(text):
    return dt.datetime.fromisoformat(text.replace("Z", "+00:00"))


def iso(t):
    return t.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def ist(t):
    return t.astimezone(IST).strftime("%H:%M:%S")


def identity_text(x):
    return isinstance(x, str) and x.strip() != ""


def read_ticks(path):
    data = Path(path).read_bytes()
    ticks, bad = [], 0
    for line in data.decode("utf-8-sig").splitlines():
        if not line.strip():
            continue
        try:
            t = json.loads(line)
            t["_t"] = parse_time(t["t"])
            ticks.append(t)
        except (ValueError, KeyError, TypeError):
            bad += 1
    ticks.sort(key=lambda t: t["_t"])
    return ticks, bad, hashlib.sha256(data).hexdigest()


def read_blocks(path):
    data = Path(path).read_bytes()
    blocks = []
    for line in data.decode("utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if r.get("kind") == "sepolia" and r.get("mode") == "cold" and isinstance(r.get("at"), str):
            blocks.append({"run": r.get("run"), "block": r.get("block"), "slot": r.get("slot"), "start": parse_time(r["at"])})
    return blocks, hashlib.sha256(data).hexdigest()


def wrapper_id(t):
    return t.get("wid", t.get("w"))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("monitor")
    ap.add_argument("log")
    ap.add_argument("--out")
    ap.add_argument("--md")
    a = ap.parse_args()
    for target in (a.out, a.md):
        if target and Path(target).resolve() in (Path(a.monitor).resolve(), Path(a.log).resolve()):
            sys.exit("refusing to write over an input file")

    ticks, bad, monitor_sha = read_ticks(a.monitor)
    blocks, log_sha = read_blocks(a.log)
    if not ticks:
        sys.exit("the monitor file has no readable tick")

    # The previous tick of the same wrapper, as in the checker.
    prev = {}
    last = {}
    for i, t in enumerate(ticks):
        w = wrapper_id(t)
        prev[i] = last.get(w)
        last[w] = i

    baseline = next((t for t in ticks if identity_text(t.get("net")) and identity_text(t.get("saltId"))), None)

    def comparable(t):
        return (baseline is not None and t["_t"] >= baseline["_t"] and identity_text(t.get("net"))
                and identity_text(t.get("saltId")) and t.get("saltId") == baseline.get("saltId"))

    def rx_delta(i):
        p = prev[i]
        if p is None:
            return None
        a_, b_ = ticks[p].get("rxBytes"), ticks[i].get("rxBytes")
        if isinstance(a_, (int, float)) and isinstance(b_, (int, float)):
            return b_ - a_
        return None

    cpu = [t["cpuPct"] for t in ticks if isinstance(t.get("cpuPct"), (int, float))]
    rx = [d for d in (rx_delta(i) for i in range(len(ticks))) if d is not None and d >= 0]
    comp = [t for t in ticks if comparable(t)]
    differing = [t for t in comp if t.get("net") != baseline.get("net")]
    gateway_changes = sum(1 for i, t in enumerate(ticks) if prev[i] is not None and t.get("gw") != ticks[prev[i]].get("gw"))
    iface_changes = sum(1 for i, t in enumerate(ticks)
                        if prev[i] is not None and json.dumps(t.get("ifaces")) != json.dumps(ticks[prev[i]].get("ifaces")))

    overall = {
        "ticks": len(ticks),
        "unreadable_lines": bad,
        "wrappers": len({wrapper_id(t) for t in ticks}),
        "first_tick_utc": iso(ticks[0]["_t"]),
        "last_tick_utc": iso(ticks[-1]["_t"]),
        "first_tick_ist": ist(ticks[0]["_t"]),
        "last_tick_ist": ist(ticks[-1]["_t"]),
        "largest_gap_s": max((t.get("gapSeconds") or 0) for t in ticks),
        "ticks_with_gap_over_90_s": sum(1 for t in ticks if (t.get("gapSeconds") or 0) > GAP_S),
        "ticks_not_on_mains": sum(1 for t in ticks if t.get("power") != "Online"),
        "ticks_wifi_down": sum(1 for t in ticks if t.get("wifiUp") is False),
        "ticks_vpn_up": sum(1 for t in ticks if (t.get("vpn") or 0) > 0),
        "ticks_restart_pending": sum(1 for t in ticks if t.get("restartPending") is True),
        "ticks_measurement_process_alive": sum(1 for t in ticks if isinstance(t.get("node"), dict) and t["node"].get("alive") is True),
        "default_gateway_changes_between_ticks": gateway_changes,
        "interface_changes_between_ticks": iface_changes,
        "network_identity": {
            "baseline_present": baseline is not None,
            "ticks_compared": len(comp),
            "ticks_same": len(comp) - len(differing),
            "ticks_different": len(differing),
            "ticks_not_comparable": len(ticks) - len(comp),
        },
        "cpu_pct": {
            "ticks_with_value": len(cpu),
            "median": round(statistics.median(cpu), 1) if cpu else None,
            "max": round(max(cpu), 1) if cpu else None,
            "ticks_over_25_pct": sum(1 for c in cpu if c > NOTE_CPU_PCT),
        },
        "received_kb_per_minute": {
            "intervals": len(rx),
            "median": round(statistics.median(rx) / 1024) if rx else None,
            "max": round(max(rx) / 1024) if rx else None,
            "intervals_over_1_mb": sum(1 for d in rx if d > NOTE_RX_BYTES),
        },
    }

    windows = []
    for b in blocks:
        lo = b["start"] - dt.timedelta(seconds=LOOKBACK_S)
        hi = b["start"] + dt.timedelta(seconds=LOOKAHEAD_S)
        idx = [i for i, t in enumerate(ticks) if lo <= t["_t"] <= hi]
        gaps = [t for t in ticks if (t.get("gapSeconds") or 0) > GAP_S and t["_t"] >= lo
                and t["_t"] - dt.timedelta(seconds=t["gapSeconds"]) <= hi]
        same = diff = other = 0
        for i in idx:
            t = ticks[i]
            if comparable(t):
                if t.get("net") != baseline.get("net"):
                    diff += 1
                else:
                    same += 1
            else:
                other += 1
        state = "DIFFERENT" if diff else ("SAME" if same else "UNKNOWN")
        rx_notes = [round(rx_delta(i) / 1024) for i in idx if rx_delta(i) is not None and rx_delta(i) > NOTE_RX_BYTES]
        windows.append({
            "run": b["run"],
            "block": b["block"],
            "slot": b["slot"],
            "started_at_utc": iso(b["start"]),
            "ticks_in_window": len(idx),
            "ticks_with_gap_over_90_s": len(gaps),
            "wifi_down": sum(1 for i in idx if ticks[i].get("wifiUp") is False),
            "vpn_up": sum(1 for i in idx if (ticks[i].get("vpn") or 0) > 0),
            "default_gateway_changed": sum(1 for i in idx if prev[i] is not None and ticks[i].get("gw") != ticks[prev[i]].get("gw")),
            "interfaces_changed": sum(1 for i in idx if prev[i] is not None
                                      and json.dumps(ticks[i].get("ifaces")) != json.dumps(ticks[prev[i]].get("ifaces"))),
            "network_state": state,
            "identity_ticks": {"same": same, "different": diff, "not_comparable": other},
            "notes": {
                "not_on_mains": sum(1 for i in idx if ticks[i].get("power") != "Online"),
                "restart_pending": sum(1 for i in idx if ticks[i].get("restartPending") is True),
                "cpu_over_25_pct": sum(1 for i in idx if isinstance(ticks[i].get("cpuPct"), (int, float)) and ticks[i]["cpuPct"] > NOTE_CPU_PCT),
                "received_over_1_mb_kb": rx_notes,
            },
        })

    states = {s: sum(1 for w in windows if w["network_state"] == s) for s in ("SAME", "DIFFERENT", "UNKNOWN")}
    summary = {
        "description": "Sanitised summary of the network monitor of the Sepolia run of 12 November 2026 (counts and times only).",
        "script": "results/run_2026-11-12/make_monitor_summary.py",
        "monitor_file": {"name": Path(a.monitor).name, "sha256": monitor_sha, "published": False},
        "log_file": {"name": Path(a.log).name, "sha256": log_sha},
        "rules": {"gap_s": GAP_S, "window_before_start_s": LOOKBACK_S, "window_after_start_s": LOOKAHEAD_S,
                  "note_cpu_pct": NOTE_CPU_PCT, "note_received_bytes_per_minute": NOTE_RX_BYTES},
        "withheld_fields": ["gw", "net", "saltId", "w", "wid", "ifaces", "batteryPct", "txBytes", "node.cpuSec", "node.wsMB"],
        "overall": overall,
        "block_windows_by_network_state": states,
        "block_windows": windows,
    }
    text = json.dumps(summary, indent=2) + "\n"
    if a.out:
        Path(a.out).write_text(text, encoding="utf-8", newline="\n")
    else:
        sys.stdout.write(text)

    if a.md:
        o = overall
        ni = o["network_identity"]
        lines = [
            "# Network monitor of the Sepolia run, 12 November 2026 (sanitised summary)",
            "",
            f"Made by `{summary['script']}` from the raw monitor file `{summary['monitor_file']['name']}`",
            f"(SHA-256 `{monitor_sha}`, the hash in `verdict_final.json`) and the closed log `{summary['log_file']['name']}`",
            f"(SHA-256 `{log_sha}`). The raw file is not published: its gateway and network fields are salted",
            "hashes, and it names the wrapper processes and network adapters. This summary holds counts and times only.",
            "",
            f"- Ticks: {o['ticks']}, from {o['first_tick_ist']} to {o['last_tick_ist']} IST. Wrappers: {o['wrappers']}. "
            f"Unreadable lines: {o['unreadable_lines']}.",
            f"- Gaps over {GAP_S} s: {o['ticks_with_gap_over_90_s']} (largest gap {o['largest_gap_s']} s).",
            f"- Ticks not on mains: {o['ticks_not_on_mains']}. Wi-Fi down: {o['ticks_wifi_down']}. VPN up: {o['ticks_vpn_up']}. "
            f"Restart pending: {o['ticks_restart_pending']}.",
            f"- Default gateway changes between ticks: {o['default_gateway_changes_between_ticks']}. "
            f"Interface changes: {o['interface_changes_between_ticks']}.",
            f"- Network identity: {ni['ticks_same']} of {ni['ticks_compared']} compared ticks the same as the first tick, "
            f"{ni['ticks_different']} different, {ni['ticks_not_comparable']} not comparable.",
            f"- CPU: median {o['cpu_pct']['median']} %, highest {o['cpu_pct']['max']} %. "
            f"Ticks over {NOTE_CPU_PCT} % (note only): {o['cpu_pct']['ticks_over_25_pct']}.",
            f"- Received per minute: median {o['received_kb_per_minute']['median']} KB, highest "
            f"{o['received_kb_per_minute']['max']} KB. Minutes over 1 MB (note only): "
            f"{o['received_kb_per_minute']['intervals_over_1_mb']}.",
            f"- Block windows by network state: SAME {states['SAME']}, DIFFERENT {states['DIFFERENT']}, UNKNOWN {states['UNKNOWN']}.",
            "",
            "| Block | Slot | Ticks in window | Gaps over 90 s | Wi-Fi down | VPN | Gateway changed | Network state | Notes |",
            "|---|---|---|---|---|---|---|---|---|",
        ]
        for w in windows:
            n = w["notes"]
            notes = []
            if n["received_over_1_mb_kb"]:
                notes.append(", ".join(f"{k} KB received in one minute" for k in n["received_over_1_mb_kb"]))
            if n["cpu_over_25_pct"]:
                notes.append(f"CPU over 25 %, ticks: {n['cpu_over_25_pct']}")
            if n["not_on_mains"]:
                notes.append(f"not on mains, ticks: {n['not_on_mains']}")
            if n["restart_pending"]:
                notes.append(f"restart pending, ticks: {n['restart_pending']}")
            lines.append(f"| {w['block']} | {w['slot']} | {w['ticks_in_window']} | {w['ticks_with_gap_over_90_s']} | "
                         f"{w['wifi_down']} | {w['vpn_up']} | {w['default_gateway_changed']} | {w['network_state']} | "
                         f"{'; '.join(notes) if notes else 'none'} |")
        lines += ["", "Notes never fail a block; they are recorded as the checker records them."]
        Path(a.md).write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
