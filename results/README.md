# Results

What each file in this folder measured, with which script, contract and artifact version. Every statistic is
computed by `scripts/analyze-latency.js` with the definitions in `scripts/lib/stats.js`: conventional median,
Hyndman and Fan type 7 quartiles, nearest-rank 95th percentile, an order-statistic interval for the median, a
seeded bootstrap for paired speed-ups, and the same order-statistic interval over the medians of processes or blocks.

## Version 1.1.0

| File | Measured | Script |
|---|---|---|
| `local_2026-11-09_n100.jsonl` | 9 November 2026. Full verification pipeline on the Hardhat in-process network; five processes, each 100 warm-up and 20 timed verifications; per-step times. Behind the local latency table and Figure 3 of the paper | `scripts/measure-local.js` |
| `sepolia_v1.1_deployment.json` | 9 November 2026. Deployment of the version 1.1.0 contract (`0x625eD772F70199BAc1A33A3BAF49B7394bBb5FC2`), the two DIDs, credentials A and B, the revocation of A (reason code 9); gas, block numbers, deployer nonce, bytecode comparison | `scripts/deploy-sepolia.js` |
| `sepolia_2026-11-12_n100.jsonl` | 12 November 2026, closed after its self-scan. Sepolia, ten blocks at fixed times; modes P (full pipeline), S (four reads in sequence), C (four concurrent requests) and Bt (one JSON-RPC batch); all reads pinned to one block | `scripts/measure-sepolia.js` at the frozen commit `73b4cca16e7c` |

These files are published unchanged. Their SHA-256 values:

| File | SHA-256 |
|---|---|
| `local_2026-11-09_n100.jsonl` | `a6a5480b34c934d09ea233954d4be4cf9b28c9e723470f181a9b64e0b8e8a385` |
| `sepolia_2026-11-12_n100.jsonl` | `f55e20ceb868b0d20a4739043d4c43edb476b9e2acab7f210ff16cb737d543be` |
| `sepolia_v1.1_deployment.json` | `50bbf111484522a0adfee4d928dc51545acc8b8054989b3274e44128483c31d1` |
| `r2.1_local_comparison/R1code_runA_2026-11-09_output.txt` | `d83b1dd2bf0cc4694772f80a30a57066570e9017985565900d39239540160e75` |
| `r2.1_local_comparison/R1code_local_2026-11-09_n100.jsonl` | `4b66017879c35fa0804ea763986cd52bc3863bf7761d707e146adf5868d257c7` |
| `run_2026-11-12/verdict_final.json` | `e51317b0addf4fea7eb22360ac43cef423110ca121ed1f39bf5c47171ec0d80b` |
| `run_2026-11-12/check_final.txt` | `fb3d51f13e3edab35289a7c170cce0b636a60fc2ab2bf45f615b755f0ec160c4` |
| `run_2026-11-12/analysis_primary_output.txt` | `0b479813b69985977804718c436cc8791caefc3193d8b8a00494797783741668` |
| `run_2026-11-12/analysis_summary.json` | `c3aff65d5d304c810724565a311547eb4a746dd117b544f67e560c576e084705` |

The header of the Sepolia log names the RPC host (`eth-sepolia.g.alchemy.com`), the deployer and the contract, which are
public; it holds no key and no part of the URL path.

### The Sepolia run of 12 November 2026 (`run_2026-11-12/`)

- `verdict_final.json`: the final verdict of `run_day/check_sepolia_run.js` (gates, status of each block, day rule).
  It names the raw monitor file and its SHA-256.
- `check_final.txt`: the report of the checker that wrote that verdict (saved from PowerShell: byte order mark, CRLF).
- `analysis_primary_output.txt` and `analysis_summary.json`: the output of `run_day/analysis_primary.js` on the closed
  log and the verdict. The Sepolia table of the paper comes from this output.
- `monitor_summary.json` and `monitor_summary.md`: a sanitised summary of the network monitor (one tick a minute),
  made by `make_monitor_summary.py` from the raw monitor file: counts and times only, per block window as the checker
  judges it. The raw file is not published (see the main README).

### The earlier code, run again on 9 November 2026 (`r2.1_local_comparison/`)

Both files come from a clean checkout of the version 1.0.0 code (commit `4b0519c`) on the machine of the local log.

- `R1code_runA_2026-11-09_output.txt`: the output of the unchanged earlier test (`npx hardhat test` of version 1.0.0):
  47 passing, and the printed line `mean=56.353ms p50=51.590ms p95=68.438ms` for 100 verifications.
- `R1code_local_2026-11-09_n100.jsonl`: the revised harness (`scripts/measure-local.js` of version 1.1.0, copied in
  unchanged and removed afterwards) run on the earlier code; five processes of 100 warm-up and 20 timed verifications;
  median 2.72 ms. The version 1.0.0 verifier records no step times. Analyse it with
  `node scripts/analyze-latency.js results/r2.1_local_comparison/R1code_local_2026-11-09_n100.jsonl`.

### Gas (solc 0.8.19, optimiser 200 runs)

From `npx hardhat run scripts/measure-gas.js` (Hardhat 2.29.0, hard fork osaka). The Glamsterdam column is the gas of
the same transactions under the schedule that Sepolia has used since 6 October 2026 (EIP-8037, EIP-8038, EIP-2780),
computed by `scripts/lib/gas-schedule.js` from each transaction's storage writes; on 9 November 2026 it matched
Sepolia's own figures for the same calls exactly (`eth_simulateV1`, base block 12,098,173; `test/GasSchedule.test.js`,
which also checks that this table carries the measured values).

| Operation | osaka, realistic documents | Glamsterdam, realistic documents | osaka, version 1.0.0 placeholder inputs | Version 1.0.0 |
|---|---|---|---|---|
| Deployment | 3,069,348 | 21,692,728 | | 2,802,701 (Sepolia, July) |
| `createDID`, a controller's first DID | 640,821 | 3,009,361 | 279,772 | 346,878 |
| `createDID`, a controller's second DID | 466,991 | 2,139,071 | | 329,766 (Sepolia, July) |
| `revokeCredential` (45-character `urn:uuid`) | 56,791 (reason code 9) | 138,811 | 56,042 (reason code 9) | 171,188 (30-character text reason) |

Realistic documents hold one Ed25519 Multikey verification method (a 203-character JSON string, stored once; version
1.0.0 stored it a second time as an authentication method); the issuer's also holds one service entry (150
characters). The placeholder inputs are those of version 1.0.0 (`["key1"]`, `["service1"]`).

Why the two schedules differ: the transactions create 2, 27, 19 and 1 new storage slots. Under osaka a new slot costs
20,000 gas (22,100 if not accessed before in the transaction); EIP-8037 charges 64 bytes x 1,530 gas = 97,920 gas, metered
as state gas, and EIP-8038 adds 10,000 for the write, so each new slot costs about 88,000 gas more. The deployment
also pays 1,530 gas per byte of its 13,752 bytes of code instead of 200, plus 120 x 1,530 gas for the new account.
EIP-2780 lowers the intrinsic gas of a call to an existing contract from 21,000 to 15,000 and of a creation from 53,000
to 24,000. The version 1.1.0 deployment on Sepolia (`sepolia_v1.1_deployment.json`, 9 November 2026, blocks
12,099,140 to 12,099,143) used exactly the Glamsterdam values: 21,692,728, 3,009,361, 2,139,071 and 138,811 gas.

## July 2026 (version 1.0.0, superseded)

`sepolia_2026-07-21_n20.jsonl` (formerly `did2_sepolia.jsonl`, content unchanged) holds the July 2026 Sepolia run
against the version 1.0.0 contract at `0x5f9017208f3F4A97657E2b32BE433a2641DFEF07`. It timed only the four contract
reads of the verification pipeline, not a full verification, and the DIDs carried placeholder keys. The script of the
first run (sequential reads) is not part of this artifact; it used the client library's default settings, under which
each read was preceded by a chain-ID request and held for the library's 10 ms batching delay. The script of the second
run (parallelised reads) was not kept.

The July contract's metadata names solc 0.8.24, while this repository's configuration (in version 1.0.0 as now) sets
solc 0.8.19, so its bytecode cannot be rebuilt from this repository. Its interface is that of version 1.0.0 (every
function and event of the version 1.0.0 ABI is present, and it has no other function), and the gas of `createDID` and
`revokeCredential` measured on Sepolia equals the local values of the 0.8.19 compile.

| Statistic | As first reported | Definitions of version 1.1.0 |
|---|---|---|
| Sequential reads, median (n = 20) | 649.2 ms (the upper of the two middle values) | 646.8 ms |
| Sequential reads, "95th percentile" | 802.2 ms (the largest of 20 values) | 778.2 ms (nearest rank) |
| Interval for the sequential median | [634.9, 702.4] ms (bootstrap of the upper median) | [630.4, 702.4] ms (order statistics, ranks 6 and 15, 95.9 %) |
| Parallelised reads, median (second run) | 175.8 ms | 174.9 ms |
| Speed-up | 3.69 (first run's median over the second run's) | 3.72 (median of paired ratios within the second run, range 2.21-5.63); ratio of medians 3.66 |

Gas in July: `createDID` 346,878 (first DID of a controller, placeholder inputs) and 329,766 (second DID); 
`revokeCredential` 171,188; deployment 2,802,701.

Reproduce: `node scripts/analyze-latency.js results/sepolia_2026-07-21_n20.jsonl`.
