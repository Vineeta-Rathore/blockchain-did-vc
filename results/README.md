# Results

What each file in this folder measured, with which script, contract and artifact version. Every statistic is
computed by `scripts/analyze-latency.js` with the definitions in `scripts/lib/stats.js`: conventional median,
Hyndman and Fan type 7 quartiles, nearest-rank 95th percentile, an order-statistic interval for the median, and a
seeded bootstrap only for paired speed-ups.

## Version 1.1.0

| File | Measured | Script |
|---|---|---|
| `local_<date>_n100.jsonl` (to be added) | Full verification pipeline on the Hardhat in-process network; five processes, each 10 warm-up and 20 timed verifications; per-step times | `scripts/measure-local.js` |
| `sepolia_v1.1_deployment.json` (to be added) | Deployment of the version 1.1.0 contract, the two DIDs, credentials A and B, the revocation of A (reason code 9); gas, block numbers, deployer nonce, bytecode comparison | `scripts/deploy-sepolia.js` |
| `sepolia_<date>_n100.jsonl` (to be added) | Sepolia, ten blocks at fixed times; modes P (full pipeline), S (four reads in sequence), C (four concurrent requests) and Bt (one JSON-RPC batch); all reads pinned to one block | `scripts/measure-sepolia.js` |

### Gas (solc 0.8.19, optimiser 200 runs)

From `npx hardhat run scripts/measure-gas.js` (Hardhat 2.29.0, hard fork osaka). The Glamsterdam column is the gas of
the same transactions under the schedule that Sepolia has used since 6 October 2026 (EIP-8037, EIP-8038, EIP-2780),
computed by `scripts/lib/gas-schedule.js` from each transaction's storage writes; on 8 November 2026 it matched
Sepolia's own figures for the same calls exactly (`eth_simulateV1`, base block 12,090,651; `test/GasSchedule.test.js`).

| Operation | osaka, realistic documents | Glamsterdam, realistic documents | osaka, version 1.0.0 placeholder inputs | Version 1.0.0 |
|---|---|---|---|---|
| Deployment | 2,838,630 | 20,042,702 | | 2,802,701 (Sepolia, July) |
| `createDID`, a controller's first DID | 863,141 | 4,111,181 | 346,790 | 346,878 |
| `createDID`, a controller's second DID | 689,311 | 3,240,891 | | 329,766 (Sepolia, July) |
| `revokeCredential` (45-character `urn:uuid`) | 145,713 (reason code 9) | 579,513 | 144,964 (reason code 9) | 171,188 (30-character text reason) |

Realistic documents hold one Ed25519 Multikey verification method (a 203-character JSON string, stored once as a
verification method and once as an authentication method); the issuer's also holds one service entry (150
characters). The placeholder inputs are those of version 1.0.0 (`["key1"]`, `["service1"]`).

Why the two schedules differ: the transactions create 2, 37, 29 and 5 new storage slots. Under osaka a new slot costs
20,000 gas (22,100 if not accessed before in the transaction); EIP-8037 charges 64 bytes x 1,530 gas = 97,920 gas, metered
as state gas, and EIP-8038 adds 10,000 for the write, so each new slot costs about 88,000 gas more. The deployment
also pays 1,530 gas per byte of its 12,685 bytes of code instead of 200, plus 120 x 1,530 gas for the new account.
EIP-2780 lowers the intrinsic gas of a call to an existing contract from 21,000 to 15,000 and of a creation from 53,000
to 24,000. The gas of the version 1.1.0 deployment on Sepolia will be listed here next to these values (to be added).

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
