# Run-day addendum for the 12 Nov 2026 Sepolia run (candidate for the user's approval, 12 Nov 2026)


Status: candidate for written user approval, covering the 12 Nov 2026 Sepolia run. Section M identifies the manifest for this
exact text and tooling. Before 07:30 IST on 12 Nov, the user records their decision with the manifest hash and clock time in
LOG.md and sends the hash as specified in P7. The schedule moved from 11 Nov before any measurement, as recorded in the plan.
Words used: a slot is one of the ten fixed times; a block is the 2 warm-up and 10 timed iterations of one slot in one
invocation of the measuring script; a cluster is one invocation's block (run id and block number); a timed row is a row of mode P,
S, C or Bt that is not a warm-up row; a usable timed row has a time, no error, and P valid or S, C, Bt reads as expected (the test
of `scripts/analyze-latency.js`); a short block has fewer than 5 usable timed rows in some mode, or no rows at all; an unfit block is a short block, or a block run
on another network than the start of the run, or with UNKNOWN network identity when monitor files were supplied (F1).

## What the plan fixed before any data (plan D1-B, schedule amended before data)

"Pre-commitment: the 12 Nov run is the reported result whatever it shows. A block is repeated only after a predefined failure
(RPC or HTTP error, HTTP 429, a request over 10 s, a failed sanity or request-count check, laptop sleep, network change), once,
in a reserve slot. If blocks are still missing, the paper reports the n actually obtained." Schedule: ten slots (08:00, 09:20,
10:40, 12:00, 13:20, 14:40, 16:00, 17:20, 18:40, 20:00 IST) on Thu 12 Nov, reserve slots 20:40 and 21:20, 2 warm-up and 10 timed
iterations per block, the first request of each block reported as the cold start, "a failed day moves the run to 13 Nov".

This addendum makes those sentences operational. It adds nothing that depends on a value.

## F. Failure and repetition (implemented in `check_sepolia_run.js` and `start_sepolia_run.ps1`)

F1. A block fails when any of its rows has an error (an RPC or HTTP error, HTTP 429, a timeout); when a row's own timer is over
10 s (for S the sum of its four reads) or one request is over 10 s (the block-number read before an S, C or Bt timer, the cold
start, a cache-check read); when a sanity check fails (P not valid; S, C or Bt reads not as expected) or the request count is
wrong (one eth_blockNumber per row; four eth_call in P, S and C; one batch and no eth_call in Bt; no eth_chainId); when the block
was missed, started more than 120 s after its slot, is incomplete, or has the wrong structure; and, from the monitor files, when a
tick whose interval overlaps the window from 90 s before the block's start to 120 s after it shows a gap over 90 s (the laptop
slept or was suspended) or when a change of network (gateway, default-route interfaces, Wi-Fi down or VPN up) is seen between two consecutive ticks
of one wrapper and the interval between them overlaps the window. The gateway and interface comparisons are attached to the
later tick, which must be in the window. The gap rule checks overlap with the gap interval. A gateway change under
the same network name fails the block, but the block remains fit for network identity and is not off-network. The overlap rule
can add a reserve for a fit block at the boundary. A repetition of a fit block affects S2 only as a clean replacement, and S1
still includes all repetitions under A2.
The baseline is the first tick in time order over all monitor files with a non-empty network profile hash and salt id. Earlier
ticks are ignored for identity. NETWORK_BASELINE fails if no tick carries both. A tick is comparable when it carries both
fields and its salt matches the baseline. SAME requires at least one comparable in-window tick and a baseline match on every
comparable in-window tick. DIFFERENT takes precedence if any comparable tick differs. UNKNOWN means no comparable in-window
tick or no baseline. With monitor files supplied, UNKNOWN and DIFFERENT make the block unfit. Missing block-number reads,
missing times, a start more than 1 s early and failed structure checks also fail the block.
The --no-monitor waiver is allowed only if the day's main monitor file does not exist. Do not use it to re-evaluate a log
already judged with monitor files. NO_MONITOR_WAIVER fails as a reviewable gate, so analysis needs --accept-gate-failures.
Record the waiver and its cause in LOG.md under D3 before using that flag.
Detection limits: another access point with the same profile name, a cellular route change under the same name, or a change and
return between ticks can escape detection. Renaming the profile on the same phone can instead flag DIFFERENT. The two warm-up iterations and the cold start count for this test.
F2. Notes never fail a block and are never a reason to exclude, explain or attribute a row: mains lost, a Windows restart pending,
CPU above 25 % in a tick, more than 1 MB received in the minute of a tick.
F3. Only the first two failed blocks get the reserve slots 20:40 and 21:20, each once. Order: unfit blocks first, then the other
failed blocks; the lowest block number first within each group. No slot is added, moved or skipped; a repetition is judged by the
same checker; a failed repetition is not repeated; no reserve run is started for any reason other than the checker's plan.
A planned reserve is completed when its invocation has a footer, aborted when its invocation has no footer, or closed unused
when it has no invocation and the clock is strictly later than its slot time plus 120 seconds on the run date. A closed slot
adds no rows. An aborted invocation is judged using its recorded rows and keeps its missing-footer gate. No reserve is moved.
A reserve wrapper cannot start later than 30 s before its slot. A repetition resolves a plan entry only when both its block
and slot match. An out-of-plan invocation is listed and retained for S1 only. Its planned entry remains pending until
completed, aborted or closed unused under the rule above.

F4. A late start (after 07:59:30) happens only by an explicit decision (`-LateStart`) and only if at most two slots have passed at
the start (the wrapper does not enforce this); if more would pass, the run is not started and moves to 13 Nov, in full. Every
block whose slot has passed is logged as missed (a short block) and competes for the two slots by F3. HTTP 429 is never retried
or worked around.
The run sends requests back to back. HTTP 429 describes load from this closed-loop benchmark and the provider limit.

## D. The day rule

D1. A slot's cluster is its main-run block, or
its reserve repetition when the main block is unfit and the repetition is not. A slot is covered when its cluster is not unfit. The
day stands if at least 8 of the 10 slots are covered and every mode has at least 80 usable timed rows in the primary dataset (A1),
and no fatal gate failed (D4). Otherwise the day is failed. The checker prints this as its "day rule" line, and prints a
verdict only when it is final, that is when every planned repetition of an unfit block is completed, aborted or closed unused; before that it says NOT FINAL and
neither decision (13 Nov, or no 13 Nov) is taken. `analysis_primary.js` refuses a verdict that is not final.
Because each slot contributes at most 10 usable rows per mode, when the other two slots contribute zero rows, reaching 80
rows with exactly 8 covered slots allows no lost row. Short or UNKNOWN uncovered clusters can still contribute usable rows.

D2. If 12 Nov fails or cannot start under F4, 13 Nov is the sole fallback. Run it in full with the same files and rules
(-ExpectedDate 2026-11-13 for the Windows tools and --date 2026-11-13 for the checker). The permitted remedies for a recorded
structural cause are to restore the agreed mains, hotspot, VPN and Windows Update settings or remove newly identified competing
account traffic. Record the cause and remedy before starting the fallback and disclose them. Keep request pacing and the analysis
fixed. The frozen measuring script has no request pacing option. Report both days side by side, including a day that did not
start or a failed gate that prevented numerical analysis. The first day meeting D1 supplies the headline. If neither qualifies,
report no headline. There is no third day.
D3. No decision of the day or the evening (reserve starts, a late start, an unrecorded log, a move to 13 Nov) uses a latency,
round-trip or compute-unit value. Only the status, reason, plan and day-rule lines of `status.ps1` and the checker are used (the
checker prints no latency value unless `--values` is given). Each decision is logged with its clock time before the next block's
output is read.
D4. Every checker gate has a stable id. A failed gate stops reporting until its cause is recorded in LOG.md from the gate's text.
Fatal gates are script/label, chain, commit, block lag, warm-up/timed counts, contract, credential B, deployer/nonce at start
and end, provider, Node, ethers, time zone, agents, request timeout, main slots, pilot rows and foreign run ids, plus
RESERVE_PLAN, RESERVE_COUNT, RESERVE_SLOT_UNIQUE, RESERVE_BLOCK_UNIQUE, RESERVE_AFTER_MAIN and MAIN_COUNT. Any fatal gate
makes the day failed regardless of row sufficiency, and analysis refuses even with --accept-gate-failures. Other gates
(including monitor/baseline, missing footer, block structure and verdict-write failures) remain reviewable under the flag, with
the acceptance printed and saved. A failed or missing log self-scan bars analysis even with the flag. Data sufficiency is reported separately. A non-final verdict still cannot be analysed.
The checker receives exactly the main wrapper's monitor file and one file per reserve invocation. The verdict lists those
files. Never use --expect-* or --now on the day. A non-default expectation override is recorded and analysis refuses it.
The verdict records the evaluation time and whether a clock override was used.

## A. The analysis (implemented in `analysis_primary.js`; one command on the closed and hashed log)

A1. Primary dataset: one cluster per slot (D1), except an off-network (DIFFERENT) cluster without a fit replacement is excluded
and its usable contribution is zero. Short and UNKNOWN clusters keep their usable rows but are uncovered. All usable timed rows
of the selected, non-excluded clusters enter, failed blocks included. No row is excluded for its latency, for coming after a
reset or for a monitor note. Network exclusions are explicit in the verdict; S1 retains all clusters.
A2. Three sensitivity analyses are always printed beside the primary: S1 includes all clusters of the log, S2 keeps clean
clusters (a clean repetition replaces its failed original), S3 removes timed rows whose timer opened a new connection.
For each mode, descriptive containment is inside/outside the primary between-block range, using inclusive endpoints. If the
range is absent or has equal endpoints, or the sensitivity has no median, the flag is indeterminate. Containment is not
equivalence or evidence of robustness. Show all datasets side by side, with their differences, whatever the flag says.
Print S1 minus primary, S2 minus primary and S3 minus primary as absolute and percentage differences. These differences are
the result. Containment carries no evidential weight.

A3. A block median enters a range between blocks only if the block has at least 5 usable rows (pairs) for that quantity; smaller
blocks are counted and listed and stay in the pooled statistics.
A4. Headline quantities: the P, S, C and Bt medians; the paired median ratios S/C and S/Bt; the paired difference P minus its own
block-number read minus S. Every other number is descriptive, the cold-start median included (k of m blocks, see A6).
Median means the pooled median of the usable timed rows, or the pooled median of usable per-iteration pairs for a paired
quantity. Print the median of block medians separately. The between-block range refers to that block-level estimand.

A5. Intervals: the headline interval is the order-statistic interval over the block medians, called "the range between the blocks of
one day", with nominal exact coverage for the median of the distribution of window medians on that day under independent, exchangeable
block medians. Exchangeability is not established by the fixed sampled windows. The pooled interval is printed only as "rows taken as independent". Neither is called a
confidence interval for the latency. Paired pooled bootstrap intervals are labelled "pairs taken as independent"; pairing within an iteration does not remove dependence between iterations.
A6. For every statistic the paper gives the usable rows, the attempted rows, the blocks, and the error rows by mode and code. n =
100 is the planned size only. An error row is called an error row, never an invalid verification. p95 and max are given with the
count of rows over 10 s. No row is excluded for being over 10 s.
Give attempted and usable pairs. An attempted pair has both timed records for the same iteration and cluster. Report the
cold start as k of m blocks, where k have a finite cold time and m is the number of observed blocks in the primary dataset.

A7. Drift is read only as one pooled count over the block-mode pairs, with no exclusion and no change of the warm-up. The cold start
and the cache check are descriptive; the cache check times the fresh read first and the
known read second. C against Bt is descriptive only (the four orders are a cyclic Latin square that does not balance which mode
precedes which).
Make no statement about the size or sign of off-chain overhead from P minus B0 minus S if its between-block range includes zero.

A8. No analysis script is run on any part of the 12 Nov log until the last reserve run has ended and the log has been copied and
hashed. Every analysis number comes from one command on the hashed log; a rerun is logged with its reason.
Quote only numbers from analysis_primary.js run once on the hashed log in the paper, response letter or abstract.

A9. List rehearsals and pilots separately in the supplement with their time and error counts. The user chose no rehearsal
statistics exception. Keep rehearsal data out of all reported estimates.

## P. Procedure


P1. The user chose no day-of pilot. Preflight timing observations are recorded in LOG.md. The structural checks of power,
network, versions, hashes, restart flags and load determine whether the run may start.
P2. In rehearsals, any HTTP 429 or BLOCK_UNAVAILABLE row stops the preparation until its cause is recorded; ECONNRESET and timeout
rows change neither the protocol nor the network and are reported as the pre-run failure rate.

P3. The Alchemy free plan shown on the 10 Nov dashboard allows 30 million compute units per month and a peak throughput of
500 CU/s. Use -CuLimit 500 in the preflight. The user reports that the second app shows zero requests and that nothing else
is known to use the account.
P4. The user states Windows Update is paused until 14 Nov, with active hours 06:00-22:00. The user's choice is recorded in
LOG.md before 07:30. The preflight still checks restart flags. No Windows setting was changed by Codex.
P5. The per-block environment record (OS and CPU, connection type, VPN state, city, mains, phone model, carrier and network
generation, hotspot band, Alchemy status page) is written in LOG.md before 08:00 and after block 10.
P6. Quiet minutes (nothing started from 1 minute before a slot to 4 minutes after it), the checker is run only after the wrapper has
ended, and the files of `run_day/` are frozen at the manifest below; a change on the day needs a dated LOG.md entry first.
P7. The manifest hash is e-mailed to rathore.vineeta1@gmail.com (the corresponding author's address, given by the user on 10 Nov)
before 07:30, as a timestamp outside the laptop. A second recipient (the supervisor) is optional.
After the last reserve and before any analysis, e-mail the SHA-256 of the closed log, every monitor file and verdict_final.json
to the same address.

P8. The user confirmed the setup was unchanged when the date moved: same laptop, Alwar, Poco X6 Pro, Jio 4G+ and a 2.4 GHz
hotspot. Record the observed network generation at 07:45 and after block 10 and the per-block evidence required by P5.
P9. The later reproducibility package will include the self-scanned measurement log, checker, tests, verdict JSON and a
sanitised monitor summary retaining the evidence for network classification and exclusions. Remove personal paths, identifiers,
and secret material before publication. Raw monitor and wrapper logs remain local. Preserve the schema and the original hashes
of private inputs in the local record and identify any public redactions in the reproducibility notes.

## W. What the paper says

W1. The scheduled first day is Thursday 12 Nov 2026; the paper states the actual headline date and every actual sampled time,
including 20:40 and 21:20 when a repetition represents a slot. Replacement does not recover the original time window.
The setting is one client in Alwar, one provider and plan, and the recorded phone hotspot. Excluded DIFFERENT clusters and
retained UNKNOWN clusters are disclosed; UNKNOWN does not establish continuity of the physical hotspot. The intervals describe
the sampled blocks on that day, not other days. No claim about typical latency, a data-centre verifier, another provider,
reliability or availability rates, or any unsampled day or night.

W2. The paper states which blocks the checker flagged and why, which were repeated, which were excluded, the rehearsals and
pilots (A9), the day rule and outcome (D1), and the primary results alongside S1-S3 (A2). Report HTTP 429 counts by mode and
block. The benchmark sends requests back to back, so the errors describe this closed-loop load at the recorded provider limit
and do not estimate the rate for a typical verifier.
State that the rules were fixed on 10-12 Nov after the 9 Nov pilot and 10 Nov rehearsals had been observed. The manifest
hash and its e-mail time are the only external timestamp for the rules. The addendum was not deposited in a registry.
No hypothesis test or multiplicity adjustment is used. The seven headline intervals are descriptive. Cold start is not
handshake time. The cache check cannot show absence of provider caching.

## Q. Decisions and written approval

- Day-of pilot: none. Rehearsal statistics exception: none.
- Windows Update: user states paused until 14 Nov, active hours 06:00-22:00.
- Account plan, other use, recipient and unchanged setup: P3, P7 and P8.
- Pending: user's written decision on this exact text and the manifest in section M.
## R. Provenance of the rules (rule, origin, when, trigger; a trigger is a review or a plan sentence, never a value of the run)

| Rule | Origin | Written | Trigger |
|---|---|---|---|
| F1 | plan D1-B list, made operational | 10 Nov 00:15-02:30 | reviews 16 and 17 (thresholds 10 s, 90 s, 120 s, request counts, window); the 00:09 rehearsal block was seen first and is flagged as the plan requires, none of the rules loosened it |
| F2 | added | 10 Nov 12:30 | review 18 (PM-02): the plan's "no large downloads at block times" had no instrument |
| F3 | plan D1-B ("once, in a reserve slot"), order added | 10 Nov 00:30; short-first 10 Nov 13:30 | review 17; review 19 (M-04) |
| F4 | plan D1-B and its late-start addition | 10 Nov 01:30 | review 17 (COR-03) |
| D1, D2 | original plan fallback rule, made mechanical | 10 Nov 13:30 | review 19 (M-01) |
| D3 | added | 10 Nov 13:30 | review 19 (M-01) |
| NOT FINAL verdict, network identity rule, unfit | added | 10 Nov 15:30 | loop-2 correctness review (C2-01, C2-02) |
| D4 | added | 10 Nov 14:20 | my own check of the day rule against the checker's gates (a gate can fail with every slot covered) |
| A1-A9 | plan "Statistics" paragraph and rule 3 of 10 Nov, made operational | 10 Nov 13:30 | review 19 (M-02, M-03, M-08, M-09) |
| P1, P2 | plan "Pilot" sentence; added | 10 Nov 13:30 | review 19 (M-05, M-07) |
| P3-P7 | added | 10 Nov 13:30 | reviews 18 and 19 (PM-02, PM-03, M-05, M-06) |
| W1, W2 | added | 10 Nov 13:30 | review 19 (M-03, M-11) |

| F1, F3, D1, D4, A1 | reserve closure, network evidence and fatal gate rules | 11 Nov 2026 | review 21 and CODEX_NEXT_TASKS.md |
| A2-A6, W1-W2 | analysis reporting, containment, sampled times and load disclosure | 11 Nov 2026 | reviews 19 and 21 |
| D2, P1, P3-P9, Q | new dates, bounded remedies, user choices and publication evidence | 11 Nov 2026 | 11 Nov task update and user answers |
| F1 | baseline, comparable ticks, waiver, overlap and structure wording | 12 Nov 2026 | reviews 24 PM3-01/02/07/10, 25 M3-01/02/05/07 |
| F3 | reserve lead time and matching block and slot | 12 Nov 2026 | reviews 25 M3-03/07, review 30 W |
| D1, D4 | coverage example, fatal plan gates, recorded overrides and monitor inputs | 12 Nov 2026 | reviews 24 PM3-03/09, 25 M3-03/08 |
| A2, A4, A5 | differences, estimands and conditional coverage | 12 Nov 2026 | reviews 25 M3-04 |
| A6, A7 | cold denominator, pair attempts and zero-in-range interpretation | 12 Nov 2026 | reviews 25 M3-04/07 |
| A8, P7 | single analysis and outside closed-log timestamp | 12 Nov 2026 | reviews 25 M3-06 |
| W2 | rule provenance and descriptive scope | 12 Nov 2026 | reviews 25 M3-09/11 |

## M. Manifest

RUN_DAY_MANIFEST.sha256 in the revision directory contains the SHA-256, byte length and relative path of each file covered by
the candidate, including this addendum. The SHA-256 of the manifest itself identifies the candidate for written approval and
the outside timestamp. Any edit to a covered file requires a regenerated manifest and a new recorded decision.
