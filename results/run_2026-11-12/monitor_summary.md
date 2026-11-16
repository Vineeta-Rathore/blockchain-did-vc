# Network monitor of the Sepolia run, 12 November 2026 (sanitised summary)

Made by `results/run_2026-11-12/make_monitor_summary.py` from the raw monitor file `run_monitor.jsonl`
(SHA-256 `ad1db559e6dac33d3a088d23432094327c82375c7a391c66f991dd3867d9ff24`, the hash in `verdict_final.json`) and the closed log `sepolia_2026-11-12_n100.jsonl`
(SHA-256 `f55e20ceb868b0d20a4739043d4c43edb476b9e2acab7f210ff16cb737d543be`). The raw file is not published: its gateway and network fields are salted
hashes, and it names the wrapper processes and network adapters. This summary holds counts and times only.

- Ticks: 742, from 07:40:31 to 20:00:23 IST. Wrappers: 1. Unreadable lines: 0.
- Gaps over 90 s: 0 (largest gap 60 s).
- Ticks not on mains: 0. Wi-Fi down: 0. VPN up: 0. Restart pending: 0.
- Default gateway changes between ticks: 0. Interface changes: 0.
- Network identity: 742 of 742 compared ticks the same as the first tick, 0 different, 0 not comparable.
- CPU: median 1.4 %, highest 28.1 %. Ticks over 25 % (note only): 1.
- Received per minute: median 23 KB, highest 13787 KB. Minutes over 1 MB (note only): 14.
- Block windows by network state: SAME 10, DIFFERENT 0, UNKNOWN 0.

| Block | Slot | Ticks in window | Gaps over 90 s | Wi-Fi down | VPN | Gateway changed | Network state | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | 08:00 | 4 | 0 | 0 | 0 | 0 | SAME | 6423 KB received in one minute |
| 2 | 09:20 | 4 | 0 | 0 | 0 | 0 | SAME | none |
| 3 | 10:40 | 4 | 0 | 0 | 0 | 0 | SAME | none |
| 4 | 12:00 | 4 | 0 | 0 | 0 | 0 | SAME | none |
| 5 | 13:20 | 4 | 0 | 0 | 0 | 0 | SAME | none |
| 6 | 14:40 | 4 | 0 | 0 | 0 | 0 | SAME | none |
| 7 | 16:00 | 4 | 0 | 0 | 0 | 0 | SAME | none |
| 8 | 17:20 | 4 | 0 | 0 | 0 | 0 | SAME | none |
| 9 | 18:40 | 4 | 0 | 0 | 0 | 0 | SAME | none |
| 10 | 20:00 | 3 | 0 | 0 | 0 | 0 | SAME | none |

Notes never fail a block; they are recorded as the checker records them.
