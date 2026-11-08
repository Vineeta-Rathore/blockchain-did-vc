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

### Gas (Hardhat 2.29.0, hardfork osaka, solc 0.8.19, optimizer 200 runs)

From `npx hardhat run scripts/measure-gas.js`:

| Operation | Realistic documents | R1 placeholder inputs | Version 1.0.0 |
|---|---|---|---|
| Deployment | 2,838,630 | | 2,802,701 (Sepolia, July) |
| `createDID`, a controller's first DID | 863,141 | 346,790 | 346,878 |
| `createDID`, a controller's second DID | 689,311 | | 329,766 (Sepolia, July) |
| `revokeCredential` (45-character `urn:uuid`) | 145,713 (reason code 9) | 144,964 (reason code 9) | 171,188 (30-character text reason) |

Realistic documents hold one Ed25519 Multikey verification method (a 203-character JSON string, stored once as a
verification method and once as an authentication method); the issuer's also holds one service entry (150
characters). The placeholder inputs are those of version 1.0.0 (`["key1"]`, `["service1"]`). Sepolia has run the
Glamsterdam upgrade since 6 October 2026, while Hardhat 2.29.0 supports forks up to osaka; the Sepolia gas of the
deployment is reported next to these values, and any difference is attributed to the Glamsterdam change that causes
it.

## July 2026 (version 1.0.0, superseded)

`sepolia_2026-07-21_n20.jsonl` (formerly `did2_sepolia.jsonl`, content unchanged) holds the July 2026 Sepolia run
against the version 1.0.0 contract at `0x5f9017208f3F4A97657E2b32BE433a2641DFEF07`. It timed only the four contract
reads of the verification pipeline, not a full verification, and the DIDs carried placeholder keys. The script of the
first run (sequential reads) is not part of this artifact; it used the client library's default settings, under which
each read was preceded by a chain-ID request and held for the library's 10 ms batching delay. The script of the second
run (parallelised reads) was not kept.

| Statistic | R1 definition | Definition used from version 1.1.0 |
|---|---|---|
| Sequential reads, median (n = 20) | 649.2 ms (the upper of the two middle values) | 646.8 ms |
| Sequential reads, "95th percentile" | 802.2 ms (the largest of 20 values) | 778.2 ms (nearest rank) |
| Interval for the sequential median | [634.9, 702.4] ms (bootstrap of the upper median) | [630.4, 702.4] ms (order statistics, ranks 6 and 15, 95.9 %) |
| Parallelised reads, median (second run) | 175.8 ms | 174.9 ms |
| Speed-up | 3.69 (first run's median over the second run's) | 3.72 (median of paired ratios within the second run, range 2.21-5.63); ratio of medians 3.66 |

Gas in July: `createDID` 346,878 (first DID of a controller, placeholder inputs) and 329,766 (second DID); 
`revokeCredential` 171,188; deployment 2,802,701.

Reproduce: `node scripts/analyze-latency.js results/sepolia_2026-07-21_n20.jsonl`.
