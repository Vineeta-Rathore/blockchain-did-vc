# Run day, Thursday 12 Nov 2026: the Sepolia latency run

Everything here is a procedure for the run that SOP step 5 and plan D1-B describe. It adds no measurement of its own. The
rules (F failure and repetition, D the day rule, A the analysis, P procedure, W wording) are in the Run-day addendum
(`..\RUN_DAY_ADDENDUM_DRAFT.md` until the user approves it, then LOG.md); they are not repeated here, so that no second copy can
drift. Paths: the folder of this file is
`E:\Blockchain IAM\Journal2\Revision - 2\run_day\`; the artifact is `...\artifact_v1.1`; live files go to
`C:\Users\Lenovo\.r2_run\` (outside every workspace); the RPC line is in `E:\Blockchain IAM\PhD\.env` (never opened by hand).

## What runs

| File | What it does |
|---|---|
| `preflight.ps1` (with `preflight_chain.js` for the chain part) | Read-only checks: date and time window, time zone, clock, mains, Wi-Fi, no VPN, restart flags, Windows Update worker processes, background load (total CPU over 10 s from the performance counters, which see every process: PASS up to 10 %, WARN above 10 %, FAIL above 20 %), disk, Node, the artifact (commit, files, contract and record hashes), the chain (round trips, predicted compute-unit draw, nonce, code, credential B). `-WithPilot` adds a 3-iteration pilot and applies its gate, `..\checks\gates_2026-11-09\check_pilot.js`. |
| `start_sepolia_run.ps1` | Starts `measure-sepolia.js` and holds the keep-awake request (`SetThreadExecutionState`, checked in-process). Writes a monitor line a minute, at second 45 of the minute (mains, Wi-Fi, gateway, VPN, CPU, bytes received and sent, restart flag, sleep gaps). `-Mode Run`, `-Mode Reserve -Block k -At 20:40`, or `-Mode Rehearsal`. Refuses on the wrong date, a start after 07:59:30 (unless `-LateStart`, a decision: see below), another commit, node or record, an inherited `NODE_OPTIONS` or similar variable, an existing log, or a second wrapper. A Reserve start also refuses unless the log is exactly as the last invocation left it (`log_hashes.txt`) and the checker's plan names this block for this slot. Its log names the SHA-256 of the wrapper and of the checker. |
| `status.ps1` | Read-only: processes, last monitor tick, console, log counts, errors, next slot. It changes nothing and costs about one CPU-second; see "Quiet minutes" for when not to start it. |
| `check_sepolia_run.js` | Gate checks on the log and the monitor files (required; `--monitor` is repeated for each wrapper), the failed and missing blocks, and the plan for the reserve slots, which it also enforces (one main invocation, at most two reserve invocations, each for the block the plan names for its slot). `--plan-slot 20:40` prints only the planned block (used by the wrapper). `--blocks-json <file>` also writes the verdict (the status and reasons of every block) as JSON. |
| `analysis_primary.js` | After the run, on the closed and hashed log and the checker's `--blocks-json` verdict: the primary analysis (one cluster per slot, every usable timed row), the sensitivity analyses S1 (all clusters), S2 (clean clusters only) and S3 (no row whose timer opened a connection) side by side, the rows and error table, the paired quantities, the monitor notes. Decides nothing from a latency value. |
| `tests\` | `test_check_sepolia_run.js`: 301 scenario tests of the checker and of `analysis_primary.js` on synthetic logs built from `template_clean_block.jsonl`: `node tests\test_check_sepolia_run.js "<artifact>" "<deployment record>"` (it makes its own fake env file in a temporary folder and deletes it; never give it the real env file; it does not depend on the time of day). `test_wrapper.ps1`: checks of the wrapper's refusal paths and one complete Reserve start against a closed local port, with a log from `make_synth_log.js`: `powershell -NoProfile -ExecutionPolicy Bypass -File tests\test_wrapper.ps1` (before 20:00). `test_consistency.js "<artifact>"`: the values that several files repeat (slots, reserve slots, commit, versions, hashes, windows) agree with their pre-registered values. `mutation.js "<artifact>" "<record>"`: changes the checker and the analysis tool in 185 places, one at a time, and requires the scenario tests to notice (about an hour; not for the day). Run the first three after any change to the scripts, never during a run. |

## Before 07:30 (you)

- Do not use the deployer key for anything on 12 Nov.
- The laptop may auto-join a known Wi-Fi if the hotspot drops. If the user agrees, turn off auto-connect for other networks and record the action in LOG.md before 07:30.

- Laptop on mains, lid open, on the phone hotspot (over Wi-Fi), no VPN. Phone on its charger, in one place, battery saver off,
  hotspot auto-off off. Nothing heavy or streamed on the laptop or the phone around the block times.
- Close what you can close (the preflight warns above 10 % total CPU and fails above 20 %; this session open and otherwise idle
  used about 6-9 % on 10 Nov).
- Windows Update: the user states it is paused until 14 Nov, with active hours 06:00-22:00. This covers the scheduled
  run on 12 Nov and the sole fallback on 13 Nov. Record the setting in LOG.md before 07:30; the preflight still checks restart flags.

## 07:30 preflight

Verify the manifest before preflight. Expect "23 files checked, 0 changed or missing" and a manifest hash equal to the one you e-mailed. Stop if any name is listed or the hashes differ.

```powershell
Set-Location 'E:\Blockchain IAM\Journal2\Revision - 2'
$lines = @(Get-Content .\RUN_DAY_MANIFEST.sha256 | Where-Object { $_ -match '^([0-9a-f]{64})\s+(\d+)\s+(.+)$' })
$bad = @()
foreach ($l in $lines) {
  [void]($l -match '^([0-9a-f]{64})\s+(\d+)\s+(.+)$')
  $h = Get-FileHash -LiteralPath $Matches[3] -Algorithm SHA256 -ErrorAction SilentlyContinue
  if (-not $h) { $bad += "MISSING $($Matches[3])" } elseif ($h.Hash.ToLower() -ne $Matches[1]) { $bad += "CHANGED $($Matches[3])" }
}
"$($lines.Count) files checked, $($bad.Count) changed or missing"
$bad
"manifest SHA-256 (compare with the e-mailed value): $((Get-FileHash .\RUN_DAY_MANIFEST.sha256 -Algorithm SHA256).Hash.ToLower())"
```

The command checks the listed files only; a file added to `run_day\` and not listed is not detected (the manifest is the list).

```
powershell -NoProfile -ExecutionPolicy Bypass -File "E:\Blockchain IAM\Journal2\Revision - 2\run_day\preflight.ps1" -CuLimit 500
```

Without `-CuLimit` the chain check assumes 300 and says so (addendum P3). Every line should be PASS or INFO. A WARN is read and recorded; a FAIL stops the start until it is understood. Its round-trip and
predicted-draw lines are copied into LOG.md and never move, delay or change the run (addendum P1); its structural lines decide.
The user chose no day-of pilot. Use the preflight command above.

## 07:45 start (any time before 07:59:30)

```
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "E:\Blockchain IAM\Journal2\Revision - 2\run_day\start_sepolia_run.ps1" -Mode Run'
```

The wrapper is hidden on purpose, so that it cannot be closed by accident. Check it a minute later:

```
powershell -NoProfile -ExecutionPolicy Bypass -File "E:\Blockchain IAM\Journal2\Revision - 2\run_day\status.ps1"
```

Both processes running, a monitor tick about a minute old (ticks come every 60 s), no stderr. The script waits for each slot
(08:00 ... 20:00) and appends every iteration to `C:\Users\Lenovo\.r2_run\sepolia_2026-11-12_n100.jsonl`.

**A late start is a decision, not a default.** After 07:59:30 the wrapper refuses. `-LateStart` (also for the preflight)
starts anyway until 19:59:30: every block whose slot has passed is then logged as missed, a short block that competes for the
two reserve slots by the plan order (unfit blocks first, then the lowest block number). A late start is allowed only if at most
two slots have passed. Write the number of passed slots in LOG.md before -LateStart (the wrapper does not enforce this; the rule is addendum F4). If more would pass, do not start: the run
moves to 13 Nov, in full, with `-ExpectedDate 2026-11-13` on the wrapper, preflight and status, `--date 2026-11-13` on the
checker, and the log `sepolia_2026-11-13_n100.jsonl`.

## During the day

- After the wrapper starts, check the first line of run_monitor.jsonl and confirm both net and saltId are non-empty. If either is empty, stop the start procedure, record it in LOG.md and ask Claude or Codex. Do not start again. The checker takes the first valid tick as baseline, so one empty first tick alone is not fatal.
- Check the measurement process in the Efficiency-mode column of Task Manager once outside the quiet minutes. Record what you see.

- **Quiet minutes.** Start nothing (status, the checker, the tests, the preflight, a large copy) from 1 minute before a slot to
  4 minutes after it: a block lasts 25-35 s at the usual round trip of 110-135 ms and up to 2 minutes at 700 ms. Outside those
  minutes `status.ps1` is safe (it changes nothing). Measured on 10 Nov: about 0.7 s of wall time and one CPU-second per call,
  and no effect on the wake-up latency of a concurrent process on this laptop; the hotspot path could not be tested, which is
  why the rule exists. For a reserve run add `-Tag reserve_b3_2040` (the block and the slot). Never run the wrapper tests
  (`tests\test_wrapper.ps1`) while a run is active.
- Decisions of the day use only the status, reason, plan and day-rule lines of `status.ps1` and the checker, never a latency,
  round-trip or compute-unit value (the checker prints none unless `--values` is given); each decision is logged in LOG.md with its
  clock time before the next block's output is read (addendum D3). Run no analysis on the log until it is closed, copied and
  hashed (A8).
- Do not close, restart or put the laptop to sleep. Do not change power settings. Stay signed in: signing out or switching the
  user ends the run. Locking the screen is fine: the display may turn off, and on mains the power request keeps Modern Standby
  from starting (Microsoft, "Prepare software for modern standby": "Power requests will block the NoCS phase indefinitely on
  AC power"). That rests on the documentation and the in-process proof of the request, not on an experiment with a locked screen.
- Light work is fine between blocks, but change no tracked file of `artifact_v1.1` and run no git command that writes there:
  a "-dirty" commit makes the header gate fail and a Reserve start refuse.
- If the laptop restarts or the wrapper dies, do not start `-Mode Run` again (it refuses: the log exists). Tell Claude;
  see "When something breaks".

## After block 10 (about 20:05): check, then the reserve slots

Use the real clock and frozen expectations. Never pass --now or --expect-* on the day. If a reserve start is refused, run the same checker plan command visibly in a normal PowerShell window to read the reason: `node "...\run_day\check_sepolia_run.js" --root "...\artifact_v1.1" --env "E:\Blockchain IAM\PhD\.env" --deployment "...\artifact_v1.1\results\sepolia_v1.1_deployment.json" --log "C:\Users\Lenovo\.r2_run\sepolia_2026-11-12_n100.jsonl" --monitor "C:\Users\Lenovo\.r2_run\run_monitor.jsonl" --plan-slot 20:40 --in-progress-window 0` (add one `--monitor` for every earlier reserve wrapper; exit 0 prints the plan, 4 means no block is planned for that slot, 2 or 3 is an error whose text you read). If a checker verdict says THE DAY IS FAILED and the gates MONITOR_FILE or NETWORK_BASELINE failed, a monitor path is probably wrong: fix the path and run again before acting. Never give `--out` or `--blocks-json` the path of a log, monitor file or verdict you want to keep.

Run the checker only after the main wrapper has ended: `status.ps1` shows no lock file and the last line of the wrapper log
(`run_wrapper.txt`) is "execution state restored" (about 20:01-20:05; block 10 may start as late as 20:02:00 and takes 25-35 s).
A checker run earlier than that prints "RUN STILL IN PROGRESS" and exits 5 when the log or a monitor file was written less than
2 minutes ago, and gives no verdict and no plan; do not act on any other output from a run that has not ended. The guard needs an
invocation without a footer and, between blocks (when the log is quiet for 80 minutes), a `--monitor` file: without one a check at
midday prints a verdict and a plan for blocks that have not run yet. So: check only when the wrapper has ended. The day-rule line
may say "NOT FINAL": then run the planned repetitions first (below) and check again, or wait until unused slots close strictly after slot time +120 s; take no decision about 13 Nov before a line that
says THE DAY STANDS or THE DAY IS FAILED.

```
node "...\run_day\check_sepolia_run.js" --root "...\artifact_v1.1" --env "E:\Blockchain IAM\PhD\.env" --deployment "...\artifact_v1.1\results\sepolia_v1.1_deployment.json" --log "C:\Users\Lenovo\.r2_run\sepolia_2026-11-12_n100.jsonl" --monitor "C:\Users\Lenovo\.r2_run\run_monitor.jsonl"
```

After a reserve run, repeat `--monitor "...\reserve_b3_2040_monitor.jsonl"` for every reserve wrapper (several `--monitor`
options are allowed); without the reserve wrapper's file its repetition has no tick near it and shows as failed.

Exit 0 and "reserve plan: none": done. Otherwise the checker prints the plan (unfit blocks first, then the lowest failed block;
two slots) and the exact commands, in the hidden and detached form (a wrapper started in a window or a tool call dies with it),
for example:

```
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "...\run_day\start_sepolia_run.ps1" -Mode Reserve -Block 3 -At 20:40'
```

Start the first by 20:38:30 (it waits for the slot; its start-up work must stay outside the quiet minutes), the second only after
the first has ended (about 20:42), by 21:18:30. Run the checker again after each, but not before 4 minutes after its slot (about
20:45 and 21:25). Its line "day rule" says whether the day stands (addendum D1); "THE DAY IS FAILED" means that
13 Nov is run once, in full (D2), and nothing else. Start no reserve run that the plan does not name.

At about 20:05 Claude pastes the main log's size and SHA-256 (from `run_wrapper.txt` and `log_hashes.txt`) into LOG.md. The
wrapper refuses a Reserve start if the log is not exactly what the last invocation left, and refuses a block or a slot that
the plan does not name; a mistyped command therefore stops with a reason and appends nothing. `-AcceptUnrecordedLog` goes
on without a hash record or a monitor file (for a main run that did not end normally); it is a decision, not a habit.

## After the last block (about 21:30)

1. Final check as above, with every monitor file: `--monitor run_monitor.jsonl --monitor reserve_b3_2040_monitor.jsonl` (and the other reserve file), all in `C:\Users\Lenovo\.r2_run\`, and with `--blocks-json C:\Users\Lenovo\.r2_run\verdict_final.json`. Save the output with `| Out-File -Encoding utf8 check_final.txt` beside it (a plain `>` in Windows PowerShell 5.1 writes UTF-16); its first line is the checker's SHA-256.
2. Copy the log to `artifact_v1.1\results\sepolia_2026-11-12_n100.jsonl` and compare the SHA-256 of source and copy; copy
   the wrapper, console, stderr, monitor, `log_hashes.txt` and preflight files to `Revision - 2\run_day\output_2026-11-12\`;
   record the SHA-256 of every file in LOG.md. Only the log is meant for the public artifact (the checker scans it for the
   RPC URL). The other files hold the user name, folder names and network details and stay local.
3. The deployer's nonce must still be 4 (the footer and the checker say so). Do not commit the results to the artifact yet:
   the run's header names the frozen commit 73b4cca16e7c.
4. After the last reserve and before any analysis, send a second e-mail to the P7 recipient with SHA-256 hashes of the closed log, every monitor file and verdict_final.json. Record the sent time in LOG.md.
5. Record the Alchemy dashboard request or CU totals for 11, 12 and 13 Nov in LOG.md after the run, as each day's totals become available.
6. Analyse the closed, copied and hashed log once with `node run_day\analysis_primary.js --root artifact_v1.1 --log <copied log> --verdict <verdict_final.json> --out <summary.json>`. Quote only its numbers in the paper, response letter and abstract.


## When something breaks

- **Wrapper refuses to start:** read its reason (it is printed and written to `run_wrapper.txt`); fix the cause; try again
  before 07:59:30. After that it refuses too ("too late to start"): see "A late start is a decision" above. Output files of an
  earlier attempt with the same name are kept under another name (`.old_<time>`), never deleted.
- **"another run is active, or its lock file is stale":** look at `status.ps1`. If a wrapper really runs, leave everything
  alone. If none runs (no `start_sepolia_run.ps1` PowerShell process in Task Manager), the lock is stale after a crash:
  delete `C:\Users\Lenovo\.r2_run\sepolia_run.lock` (the delete only succeeds when nobody holds it) and start again. Never
  delete a log.
- **A block fails** (error rows, a request over 10 s, a failed sanity or request-count check, late start, sleep, network
  change): nothing to do during the day. The checker decides after block 10.
- **The laptop restarts, sleeps through blocks, or the hotspot is gone for long:** blocks without rows are short blocks and get
  the reserve slots first. The day rule decides after the last reserve run (the checker's "day rule" line); do not decide on 13 Nov
  before it says THE DAY IS FAILED, and do not start extra runs to make up the number.
- **The first reserve wrapper dies (restart, power) after it appended rows:** the log then holds rows that no record in
  `log_hashes.txt` covers, so the second reserve start is refused and `-AcceptUnrecordedLog` does not change that. The second
  reserve slot is forfeited and closes unused strictly after 21:22:00 on the run date; then the checker can finalise (addendum F3: no slot is moved or skipped). Do not edit `log_hashes.txt`; write the event in LOG.md.
- **The checker shows "off-net" or "network identity (note)":** the laptop was on another network than at 07:45 (for example it
  joined a known Wi-Fi when the hotspot dropped). Such blocks are unfit and are repeated first by the plan; nothing to do during
  the day except keeping the phone's hotspot on.
- **Never** edit, delete or re-run a log to obtain a different number. A rehearsal is not data; its log stays in
  `C:\Users\Lenovo\.r2_run\rehearsal\` and is never used.

## The rules

The rules F1-F4 (failure and repetition), D1-D4 (the day rule), A1-A9 (the analysis), P1-P9 (procedure) and W1-W2 (wording) are in
the Run-day addendum: `..\RUN_DAY_ADDENDUM_DRAFT.md` until the user approves it, then LOG.md under "Run-day addendum", with the
SHA-256 manifest of every file of this folder. The files of this folder are frozen at that manifest. A change on the day needs a
dated LOG.md entry first; the checker's own hash is printed as the first line of its output and logged by the wrapper, and a
difference from the manifest is explained in LOG.md.

Network identity is SAME, DIFFERENT or UNKNOWN. The baseline is the first tick of the day (all monitor files, time order) with a non-empty network name hash and salt id. A block is SAME when at least one in-window tick is comparable and all comparable ticks match, DIFFERENT when any comparable tick differs, and UNKNOWN (unfit) only when no in-window tick is comparable. A single empty tick among comparable ones does not make it UNKNOWN. No tick of the day with a valid identity is a failed gate. An unreadable shared salt in a reserve wrapper makes its evidence incomparable and its repetition unfit; keep the raw ticks. See addendum F1 for detection limits.

The checker records evaluated_at and clock_override. --now is for deterministic tests or documented replay only; use the real clock for operational decisions. A reserve invocation without a footer is aborted and judged once the wrapper has ended. After 13 Nov there is no third day.
