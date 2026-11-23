# Decentralised Identifier-Anchored Verifiable Credentials with On-Chain Revocation for Social Media Identity Management

Reference implementation for the paper of the same title (V. Rathore and M. K. Rawat). It contains an Ethereum
registry of DID documents with per-credential revocation keyed by the issuer DID, a Node.js service that issues W3C
Verifiable Credentials with `eddsa-jcs-2022` proofs, a verifier that checks a credential against the registry, and the
scripts and raw logs behind the paper's measurements. It covers the DID and credential layers only; it does not
implement verifiable presentations, holder binding or zero-knowledge selective disclosure.

This is version 1.1.1 (DOI [10.5281/zenodo.24451811](https://doi.org/10.5281/zenodo.24451811)). What changed since
version 1.0.0 is listed in [`CHANGELOG.md`](CHANGELOG.md). The measurement code was frozen at commit `73b4cca16e7c`
before the Sepolia run of 12 November 2026; the logs, the run tools and the figure builders were added after the run,
without changing that code. Version 1.1.1 changes only documentation, metadata, the figure sources and their build
script, and adds the full run-day manifest and `FROZEN_CODE.sha256`: the contract, the code, the tests and the
published logs are those of version 1.1.0 (DOI 10.5281/zenodo.24263442).

## Contents

- [Versions and contracts](#versions-and-contracts)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Repository layout](#repository-layout)
- [The registry](#the-registry)
- [Issuing and verifying credentials](#issuing-and-verifying-credentials)
- [Gas on two schedules](#gas-on-two-schedules)
- [Reproducing the paper](#reproducing-the-paper)
- [Sepolia scripts and secrets](#sepolia-scripts-and-secrets)
- [Maintaining this repository](#maintaining-this-repository)
- [Limits](#limits)
- [Standards](#standards)
- [Citing](#citing)
- [Contact](#contact)
- [Licence](#licence)

## Versions and contracts

The revocation function and its event changed in version 1.1.0, so each contract must be called with the ABI of its
own version.

| Version | Contract on Ethereum Sepolia (chain ID 11155111) | Revocation interface | Measurements |
|---|---|---|---|
| 1.1.0 and 1.1.1 (same contract) | `0x625eD772F70199BAc1A33A3BAF49B7394bBb5FC2`, created 9 November 2026 (block 12,099,140) | `revokeCredential(string,string,uint8)`; event `CredentialRevoked(string indexed didId, string indexed credentialId, uint8 reasonCode, uint256 timestamp)` | `results/sepolia_v1.1_deployment.json`, the logs named in [`results/README.md`](results/README.md) |
| 1.0.0 (superseded) | `0x5f9017208f3F4A97657E2b32BE433a2641DFEF07`, created 21 July 2026 | `revokeCredential(string,string,string)`; event `CredentialRevoked(string indexed didId, string indexed credentialId, string reason, uint256 timestamp)` | `results/sepolia_2026-07-21_n20.jsonl` |

The ABI of version 1.1.0 is in `artifacts/contracts/DIDRegistry.sol/DIDRegistry.json` after `npx hardhat compile`.
The ABI of version 1.0.0 comes from `contracts/DIDRegistry.sol` at commit `4b0519c`. The version 1.0.0 contract on
Sepolia was compiled with solc 0.8.24, not with the 0.8.19 set in this repository, so a compile from this repository
does not reproduce its bytecode; its interface is the version 1.0.0 ABI ([`results/README.md`](results/README.md)).

Two names in `results/` are internal labels kept because the hash tables and the version 1.1.0 archive use these
paths: `r2.1` in `results/r2.1_local_comparison/` is the reviewer comment R2.1 that asked for that comparison, and
`R1code` in its file names means the version 1.0.0 code.

## Requirements

- Node.js and npm. Tested only with Node.js 22.10.0 and npm 10.9.0 on Windows 11; Linux and macOS have not been
  tested. `engines` in `package.json` asks for Node.js 20 or later (Hardhat's simulator, EDR, needs it), but no other
  version was tested. The lock file pins a legacy toolchain (Hardhat 2.29.0, ethers 5.8.0) on purpose: it was frozen
  for the measurements and is not updated.
- Python 3.11 or 3.12 (tested with 3.12.2), with numpy only for `scripts/check_stats_numpy.py` and with matplotlib only
  for `scripts/plot-latency.py`: `python3 -m pip install -r requirements.txt` (numpy 1.26.2, matplotlib 3.10.5). The
  pinned numpy 1.26.2 has no wheel for Python 3.13 or later. On Windows the command is `python` or `py -3`; the
  commands below write `python3`.
- For the Sepolia scripts only: an Ethereum Sepolia JSON-RPC endpoint; for `deploy-sepolia.js` also a funded Sepolia
  test key (never a key that holds real funds). The run checker and the analysis of the published logs need no
  endpoint and send no request.
- For the figures only: pdflatex, pdfinfo, pdffonts and pdftoppm (tested with TeX Live 2024; LaTeX packages
  standalone, tikz and pgf, microtype, textcomp and the psnfss fonts), `sha256sum` or `shasum`, and the Python
  packages in `figures/requirements.txt`; on Windows, `bash` from Git for Windows.

## Quick start

```bash
npm ci                 # install the locked toolchain (Hardhat 2.29.0, ethers 5.8.0)
npx hardhat compile    # solc 0.8.19, optimiser on, 200 runs
npm test               # 164 tests
npm run measure-gas    # gas of each operation, on the osaka schedule and on Sepolia's
```

Run every command from the repository root. `npm ci` installs exactly the versions in `package-lock.json`;
`npm install` may resolve newer ones. Outside the repository, `npx hardhat` offers to download another Hardhat
version instead of using this one.

`npm test` runs eight suites: the registry (65 tests), credentials and verification (51), leak tests (14), the RPC
helpers' secret handling (6), the measurement harness (13), the deployment script (8), the latency analysis (4) and
the gas model (3). The deployment tests run `deploy-sepolia.js` against a Hardhat node they start on a free local
port: a fresh run, re-runs of a completed record, refusals, a run stopped before signing, a transaction dropped
before it was mined, a replacement with `--resend` and its fee ceiling, and a nonce used by another transaction. The leak tests run every measurement mode, and both Sepolia
scripts as child processes, against a local fake server that fails requests in eight ways, and check the raw rows,
output, logs and records for the fake token, the URL path and the fake deployer key, and that no request is retried.

## Repository layout

```
contracts/
  DIDRegistry.sol              DID documents, controllers, delegates, attributes, revocations, administration
src/vc/
  vc-service.js                credential issuance and eddsa-jcs-2022 proofs (Ed25519, Multikey)
  verifier-service.js          the verification pipeline (B0, V1-V8)
test/
  DIDRegistry.test.js          registry behaviour, pause scope, reason codes, admin events, repair while deactivated
  VerifiableCredential.test.js credential flow, validity period, same-block reads, eddsa-jcs-2022 test vector
  leak.test.js                 no RPC URL or token in any output when the endpoint fails; no retries
  rpc.test.js                  what the Sepolia scripts treat as a secret (fake URLs only)
  harness.test.js              connection reuse, the mode order of each block, interval estimates, argument errors
  deploy.test.js               deploy-sepolia.js against a local Hardhat node: fresh, completed, refused, interrupted
  analyze.test.js              the latency analysis counts only successful measurements
  GasSchedule.test.js          the Sepolia gas model against values observed on Sepolia, and the gas tables of the docs
  fixtures/eddsa-jcs-2022-B3.json   W3C test vector (the specification's published test key)
scripts/
  measure-gas.js               gas of deploy, createDID and revokeCredential (Hardhat network)
  measure-local.js             verification latency on the Hardhat network, per step
  measure-sepolia.js           verification latency on Sepolia, four modes, read-only
  deploy-sepolia.js            the Sepolia setup: contract, two DIDs, two credentials, one revocation
  analyze-latency.js           statistics for every latency log
  check_stats_numpy.py         cross-check of the statistics against numpy
  plot-latency.py              the latency figure from the local log
  deploy.js                    deployment to a local `npx hardhat node`
  lib/                         statistics, fixtures, gas model, RPC helpers, measurement modes, argument parsing
results/
  README.md                    what each log measured, with which script, contract and version
  *.jsonl, *.json              raw logs and the deployment record
  run_2026-11-12/              verdict, checker report and analysis of the Sepolia run; monitor summary and its script
  r2.1_local_comparison/       the earlier test and the revised harness, both run on the version 1.0.0 code
run_day/                       the rules and tools of the Sepolia run, as fixed before it (byte for byte; only the comment header of `MANIFEST_SUBSET.sha256` was written later)
  RUN_DAY.md                   the run-day procedure
  RUN_DAY_ADDENDUM_DRAFT.md    the pre-registration addendum (the run-day rules)
  RUN_DAY_MANIFEST.sha256      the full manifest of the rule files, whose SHA-256 was e-mailed before the run
  MANIFEST_SUBSET.sha256       the manifest lines of the published run-day files, mapped to their paths here
  check_sepolia_run.js         the run checker
  analysis_primary.js          the analysis of the closed log
  preflight_chain.js           the chain check before the run
  *.ps1                        the Windows PowerShell wrapper, preflight and status tools (Windows only)
  tests/                       tests of the run checker and of the run tools, and the mutation run
figures/                       builders of Figures 1 to 3 and of the graphical abstract (output in figures/out/)
test-transcripts/              the npm test run at the archived commit 73b4cca
FROZEN_CODE.sha256             SHA-256 of the nine measurement files at the freeze commit 73b4cca16e7c
out/                           not in the repository: the folder the commands below write to (git ignores it)
```

## The registry

`contracts/DIDRegistry.sol` stores each DID document on chain: its identifier, controller address, verification
methods, services, creation and update times, an `active` flag, a hash of the full document and a nonce.
`getDIDDocument` also returns authentication methods, which are always the verification methods and are not stored a
second time. The controller of a DID can update the document, rotate a key, hand the DID to another address, add or
remove delegates, set attributes, deactivate and reactivate the DID, and revoke credentials that the DID issued.

A handover takes two steps. `changeController(did, newAddress)` records a proposal (event `ControllerChangeProposed`);
control moves only when that address calls `acceptController(did)` (event `ControllerChanged`). Until then the
current controller keeps full control, can replace the proposal with another, or withdraw it with
`cancelControllerChange(did)` (event `ControllerChangeCancelled`). `getPendingController(did)` returns the proposed
address. Deactivating the DID withdraws a pending proposal, so it cannot be accepted after reactivation.

Revocation is keyed by the issuer DID and the credential ID: `revokeCredential(issuerDid, credentialId, reasonCode)`
can be called only by the controller of `issuerDid`, and a revocation is final. The entry stores the time and a reason
code from RFC 5280, section 5.3.1, in one storage slot; `getRevocationEntry` returns the credential ID it was asked
about, which is the key of the entry and is not stored again:

| Code | Meaning | Accepted |
|---|---|---|
| 0 | unspecified (used here for "not stated") | yes |
| 1 | keyCompromise | yes |
| 2 | cACompromise | yes |
| 3 | affiliationChanged | yes |
| 4 | superseded | yes |
| 5 | cessationOfOperation | yes |
| 6 | certificateHold | no: a revocation here cannot be undone |
| 7 | not used in RFC 5280 | no |
| 8 | removeFromCRL | no: applies to delta CRLs only |
| 9 | privilegeWithdrawn | yes |
| 10 | aACompromise | yes |
| above 10 | not defined | no |

Rejected codes revert with "DIDRegistry: Invalid reason code", and an empty credential ID with "DIDRegistry: Invalid
credential ID". The reason code is public, like everything else the
registry stores.

Administration. The deploying account becomes `owner` and the first administrator. Administrators can add and remove
administrators (not the owner) and pause or unpause the registry; each of these actions emits an event (`AdminAdded`,
`AdminRemoved`, `Paused`, `Unpaused`). While the registry is paused, `createDID`, `updateDID`, `reactivateDID`,
`changeController`, `acceptController`, `rotateKey`, `addDelegate`, `removeDelegate` and `setAttribute` revert;
`revokeCredential`, `deactivateDID`, `cancelControllerChange` and every read function keep working, so a pause cannot
stop an issuer from revoking, a controller from deactivating a DID, or a controller from withdrawing a handover
proposal before the registry is unpaused. No administrator function changes, revokes or deactivates another controller's DID or
credentials. The contract has no upgrade mechanism and no function that transfers ownership.

A deactivated DID can still have a key rotated or its document updated (to repair it before reactivation); it stays
deactivated until its controller reactivates it. As the authentication methods are the verification methods, a key
rotation or an update changes both.

## Issuing and verifying credentials

`src/vc/vc-service.js` issues credentials in the W3C Verifiable Credentials Data Model 2.0 with an `eddsa-jcs-2022`
Data Integrity proof (Ed25519 keys in Multikey encoding). Following section 3.3.1 of the cryptosuite specification,
the credential's `@context` is copied into the proof before the proof configuration is hashed; a test reproduces the
proof value of the W3C test vector (appendix B.3). Credentials signed by version 1.0.0, whose proofs have no
`@context`, still verify.

`src/vc/verifier-service.js` checks a credential in the order below and stops at the first failure:

| Step | Check | Result if it fails |
|---|---|---|
| V1 | `@context` starts with the VC 2.0 base context and `type` includes `VerifiableCredential`; `id` (a non-empty string, because revocation is keyed by it), `issuer`, `credentialSubject.id` and `proof.verificationMethod` are present; the VC 1.1 properties `issuanceDate` and `expirationDate` are absent; `issuer` and `credentialSubject.id` are strings; `validFrom` and `validUntil`, if present, are date-time stamps with a time zone and a real calendar date, and `validUntil` is not earlier than `validFrom` | `MALFORMED_CREDENTIAL`, `MISSING_PROOF` |
| B0 | read the newest block number N with a plain `eth_blockNumber` request (or use the caller's block number, an integer 0 or more) | `VERIFICATION_ERROR` |
| V2 | the issuer DID exists and is active at block N | `ISSUER_DID_INACTIVE_OR_UNKNOWN` |
| V3 | the subject DID exists and is active at block N | `SUBJECT_DID_INACTIVE_OR_UNKNOWN` |
| V4 | `validFrom` is not later than now plus the clock tolerance (default 60 s); `validUntil` is later than now ("now" is the moment reported as `checkedAt`) | `CREDENTIAL_NOT_YET_VALID`, `CREDENTIAL_EXPIRED` |
| V5 | the issuer's DID document at block N is active, carries the issuer DID as its `id` and lists the proof's verification method, which is a `Multikey` controlled by the issuer DID and named under it | `ISSUER_DID_INACTIVE_OR_UNKNOWN`, `VERIFICATION_METHOD_NOT_FOUND` |
| V6 | the proof has type `DataIntegrityProof`, cryptosuite `eddsa-jcs-2022` and purpose `assertionMethod`, and has not expired (`proof.expires`); the credential's `@context` equals the proof's; the Ed25519 signature is valid | `INVALID_SIGNATURE` |
| V7 | the issuer has not revoked the credential at block N | `CREDENTIAL_REVOKED` |
| V8 | all checks passed | `VALID` |

Same-block reads: the four contract reads (V2, V3, V5, V7) are `eth_call` requests pinned to block number N, so all
four answers describe the chain at that height (a reorganisation that replaces block N while the verification runs is
not detected). The result reports N as `checkedAtBlock`; with a caller's past block number, the answer is as of that
block. Invalid options (`clockToleranceMs` that is not a finite number of 0 or more, `blockLag` that is not an integer
of 0 or more) raise a `TypeError`; an invalid block number gives `VERIFICATION_ERROR` with `INVALID_BLOCK_TAG`. A failed request returns
`VERIFICATION_ERROR` with an `errorCode` (for example `TIMEOUT` or `SERVER_ERROR`), never the library's error message,
which can contain the RPC URL.

```js
const { CredentialVerifierService } = require('./src/vc/verifier-service');
const verifier = new CredentialVerifierService(registryContract, {
  clockToleranceMs: 60000, // tolerance for validFrom (default 60 s)
  timing: false,           // true: duration of each step in result.timings (ms)
  blockLag: 0,             // pin the reads this many blocks below the newest
});
const result = await verifier.verifyCredential(credential);            // or { blockTag: n } as a second argument
// { valid, reason, checkedAt, checkedAtBlock, issuerDid, subjectDid, credentialId, timings? }, see below
```

The method returns a result object with `valid`, `reason`, `checkedAt` and, except for `VERIFICATION_ERROR`,
`issuerDid`, `subjectDid` and `credentialId`; `checkedAtBlock` is `null` when a structure check fails before step B0,
and a `VERIFICATION_ERROR` result carries `errorCode` instead of the three identifiers.

## Gas on two schedules

Hardhat 2.29.0 simulates hard forks up to osaka, which is the gas schedule of Ethereum mainnet at the time of writing.
Sepolia has used the Glamsterdam schedule since its upgrade on 6 October 2026. Three of its changes raise the cost of
this registry: EIP-8037 charges 1,530 gas for every byte of new state (64 bytes per new storage slot, 120 per new
account, one per byte of deployed code), EIP-8038 raises the cost of writing a storage slot, and EIP-2780 changes the
intrinsic gas of a transaction. `npm run measure-gas` prints both, for DID documents that hold one Ed25519 Multikey
verification method (the issuer's also one service entry):

| Operation | osaka (Hardhat) | Glamsterdam (Sepolia) | New storage slots |
|---|---|---|---|
| Deployment (13,752 bytes of code) | 3,069,348 | 21,692,728 | 2 |
| `createDID`, a controller's first DID | 640,821 | 3,009,361 | 27 |
| `createDID`, a controller's second DID | 466,991 | 2,139,071 | 19 |
| `revokeCredential` (45-character credential ID, reason code 9) | 56,791 | 138,811 | 1 |

The Glamsterdam column is computed by `scripts/lib/gas-schedule.js` from the storage writes of each local
transaction. It matched the gas that Sepolia reported for the same calls (`eth_simulateV1`, 9 November 2026)
exactly; `test/GasSchedule.test.js` checks this, and that the figures in this file, in `results/README.md` and in
`CHANGELOG.md` are the measured ones. Most of the gas is spent on new storage slots. The registry stores nothing twice
and keeps the `active` flag in the controller's slot, but it is not otherwise packed: the two timestamps and the nonce
take a full slot each, and the delegation and attribute functions, which grant no permission (see Limits), add to the
code and so to the deployment gas. The deployment needs more gas than the 16,777,216 that EIP-7825 allows a
transaction; Sepolia accepts it because EIP-8037 meters the state gas outside that cap (checked with `eth_simulateV1`
with validation, and with transactions of 20 to 30 million gas mined on Sepolia on 9 November 2026). The three EIPs
were in Last Call at that date and may still change before they reach mainnet. The gas of the actual Sepolia deployment
of 9 November 2026 is in `results/sepolia_v1.1_deployment.json`: 21,692,728, 3,009,361, 2,139,071 and 138,811 for the
four transactions, the values of the Glamsterdam column.

## Reproducing the paper

After `npm ci` and one `npx hardhat compile` (both need network access; the compile downloads solc 0.8.19 once), every
command below works offline. The figure build needs only its pinned Python packages and TeX Live. The commands are
written for `bash` and run from the repository root; in PowerShell, write `(Get-Location).Path` for `"$(pwd)"`. The
run-day scripts need `--root` as an absolute path. Every command below that writes an output file writes it to `out/`
(the compiler and the tests write only the git-ignored `artifacts/` and `cache/`), never to `results/`, whose logs
are published byte for byte; create `out/` with `mkdir -p out` (git ignores it).

Each table and figure of the paper, the command that reproduces it, the output to compare, and the time the command
took on the authors' laptop (Table 2) on 22 November 2026:

| Paper item | Command | Output to compare | Time |
|---|---|---|---|
| Table 1 (related work) | none | not produced by this repository: its cells cite pinned commits and pages in the paper's references | - |
| Table 2 (configuration) | `node --version`; `npx hardhat --version`; `npx hardhat compile` | Node.js 22.10.0 and Hardhat 2.29.0; solc 0.8.19, optimiser on, 200 runs, hard fork osaka in `hardhat.config.js`; ethers 5.8.0 in `package-lock.json`; the header rows of `results/local_2026-11-09_n100.jsonl` record the laptop | 10 s |
| Table 3 (gas) | `npm run measure-gas`, then `GAS_INPUTS=results/sepolia_v1.1_deployment.json npx hardhat run scripts/measure-gas.js` | JSON on the console with the values of the table in "Gas on two schedules"; the Sepolia receipts are the `gasUsed` fields of `results/sepolia_v1.1_deployment.json` | 10 s each |
| Table 4 (local latency) | `node scripts/analyze-latency.js results/local_2026-11-09_n100.jsonl` | console: n = 100, median 2.77 ms, mean 2.92 ms, p95 3.82 ms, maximum 5.03 ms; process medians 3.25, 2.73, 2.69, 2.73 and 2.76 ms | 1 s |
| Earlier test (text of the local evaluation) | `node scripts/analyze-latency.js results/r2.1_local_comparison/R1code_local_2026-11-09_n100.jsonl`; the earlier test's own output is `results/r2.1_local_comparison/R1code_runA_2026-11-09_output.txt` | median 2.72 ms; the output file holds "mean=56.353ms" | 1 s |
| July 2026 run (version 1.0.0) | `node scripts/analyze-latency.js results/sepolia_2026-07-21_n20.jsonl` | sequential median 646.8 ms (n = 20) | 1 s |
| Table 5 (Sepolia) | `node run_day/analysis_primary.js --root "$(pwd)" --log results/sepolia_2026-11-12_n100.jsonl --verdict results/run_2026-11-12/verdict_final.json --out out/analysis_summary.json > out/analysis_primary_output.txt`, then `cmp out/analysis_primary_output.txt results/run_2026-11-12/analysis_primary_output.txt` and `cmp out/analysis_summary.json results/run_2026-11-12/analysis_summary.json` | both `cmp` commands print nothing | 5 s |
| Table 6 (tests) | `npm test` | "164 passing"; per suite 65, 51, 14, 13, 8, 6, 4 and 3, as in `test-transcripts/npm_test_73b4cca_2026-11-15.txt`, the run at the archived commit | 1.5 min |
| Figures 1 to 3 and the graphical abstract | `bash figures/build_all.sh out/figures` | `out/figures/SHA256SUMS.txt` against the hash table under "Figures" below | 15 s |
| Statistics against numpy | `python3 scripts/check_stats_numpy.py` | "0 mismatches" | 1 s |
| Run-day consistency checks | `node run_day/tests/test_consistency.js "$(pwd)"` | "55 consistency checks, 0 wrong" | 2 s |

New measurements are optional and write new logs, so their values differ from the paper's (machine, day, provider):

| New measurement | Command | Output | Time |
|---|---|---|---|
| Local latency (Table 4) | `for k in 1 2 3 4 5; do LOCAL_LOG=out/local_rerun.jsonl PROCESS_INDEX=$k npx hardhat run scripts/measure-local.js; done`, then `node scripts/analyze-latency.js out/local_rerun.jsonl` | `out/local_rerun.jsonl` (five header rows and 600 measurement rows, 100 of them timed) and its analysis | 7 s per process |
| Sepolia latency (Table 5) | `node scripts/measure-sepolia.js --deployment results/sepolia_v1.1_deployment.json --log out/sepolia_rerun.jsonl --env <your env file>`, then `node scripts/analyze-latency.js out/sepolia_rerun.jsonl` | `out/sepolia_rerun.jsonl` and its analysis | one day: ten blocks from 08:00 to 20:00 machine local time |
| Latency figure, quick plot | `python3 scripts/plot-latency.py results/local_2026-11-09_n100.jsonl --out out/latency_quick.pdf --expect-n 100` | a plot of the local log (not the submitted Figure 3) | 3 s |

Never point `LOCAL_LOG` or `--log` at a file in `results/`: the scripts append to it. In PowerShell the loop is
`foreach ($k in 1..5) { $env:LOCAL_LOG = "out/local_rerun.jsonl"; $env:PROCESS_INDEX = "$k"; npx hardhat run scripts/measure-local.js }`.
Variables set this way stay set for the whole PowerShell session: remove them afterwards
(`Remove-Item Env:LOCAL_LOG, Env:PROCESS_INDEX, Env:GAS_INPUTS`), because a leftover `GAS_INPUTS` switches
`npm run measure-gas` to replay mode and a leftover `PROCESS_INDEX` repeats a process index (which
`analyze-latency.js` reports).

Environment variables:

| Variable | Read by | Meaning |
|---|---|---|
| `SEPOLIA_RPC_URL` | `measure-sepolia.js`, `deploy-sepolia.js` (or the one line of the `--env` file) | the Sepolia JSON-RPC URL; a set variable takes precedence over the `--env` file |
| `LOCAL_LOG` | `measure-local.js` | the log file the rows are appended to |
| `PROCESS_INDEX` | `measure-local.js` | the number of this process (1 to 5) |
| `GAS_INPUTS` | `measure-gas.js` | a deployment record whose inputs are replayed |
| `TEX` | `figures/build_all.sh` | the folder of the TeX binaries, if they are not on PATH |
| `PY` | `figures/build_all.sh` | the Python command (default `python3`, else `python`) |

If something fails: `npx hardhat` outside the repository downloads another Hardhat; PowerShell sets variables with
`$env:NAME = "value"`, not `NAME=value`; on Windows `python3` may be a Microsoft Store stub (use `python` or `py -3`);
the first compile needs network access.

`analyze-latency.js` counts only measurements that succeeded (a valid verification, or reads with a time, no error
and the expected answers) and leaves out pilot rows; it reports the rows it left out, by mode and error code, rows
with unexpected request counts, and rows whose timer included a new connection, by mode and order. Measurements of
one process (local) or one block (Sepolia) are not independent, so it also gives the median of each process or block,
the median of those medians with a distribution-free interval from their order statistics and its exact coverage (the
range of five process medians, 93.75%; the 2nd to the 9th of ten block medians, 97.9%), the same for the paired
speed-ups, and the medians of the first and second halves of each process or block (a check that the warm-up was long
enough). The pooled interval treats every row as independent and is printed as such, and so does the bootstrap of
a paired speed-up ("pairs resampled"). The coverage of the interval over medians is exact if the process or block
medians are independent draws from one continuous distribution; the ten Sepolia blocks sit at fixed times of one day,
so what it estimates is the median over those time slots on that day, not over days. It warns
when the headers of one log disagree (commit, machine, versions), when a process index repeats, and when a header
records a checkout that differs from its commit. `scripts/lib/stats.js` defines every statistic once: the conventional median, quartiles by the Hyndman and Fan type 7
rule, the nearest-rank 95th percentile, an order-statistic confidence interval for the median (of the rows, or of the
process or block medians), and a seeded percentile bootstrap for paired speed-ups. Each log, and what produced it, is described in
[`results/README.md`](results/README.md).

Tests. `npm test` runs the 164 tests; `test-transcripts/npm_test_73b4cca_2026-11-15.txt` is the run at the archived
commit (164 passing, exit 0). The run checker and the run tools have their own tests, which `npm test` does not run:

```bash
node run_day/tests/test_consistency.js "$(pwd)"
node run_day/tests/test_check_sepolia_run.js "$(pwd)" "$(pwd)/results/sepolia_v1.1_deployment.json"
```

The first gives 55 checks and the second 301 scenarios (about three minutes); both make their own fake inputs.
`run_day/tests/mutation.js` is the mutation run of the run checker (usage in its header); its runtime was not timed
for this README. One of the 55 consistency checks compares `contracts/DIDRegistry.sol` with its manifest hash.
`contracts/DIDRegistry.sol` is checked out with CRLF line endings (`eol=crlf` in `.gitattributes`; the git object and
the raw file on GitHub hold LF): these are the bytes that were compiled and deployed (24,883 bytes, SHA-256
2a4e07578c99...). The compiler's metadata hash covers the source bytes,
so the same file with LF endings compiles to the same code except for the 32-byte metadata hash (runtime keccak
0x7c2e3be6...32f7 instead of 0x355a986a...0679), and the contract line of the manifest then does not match.
`run_day/MANIFEST_SUBSET.sha256` shows how to check the contract against its manifest line.

Analysis of the Sepolia run. `run_day/analysis_primary.js` (the Table 5 row above) reads the closed log and the final
verdict and writes the tables of the paper. Both outputs equal `results/run_2026-11-12/analysis_primary_output.txt`
and `analysis_summary.json` byte for byte (checked on 16 November 2026 and again on 22 November 2026 with Node.js
22.10.0 on Windows 11).

The run checker. `run_day/check_sepolia_run.js` wrote `results/run_2026-11-12/verdict_final.json` and
`check_final.txt` from the log, the deployment record and the raw monitor file. The raw monitor file is not published,
so the verdict cannot be recomputed from this repository. Running the checker with `--no-monitor` is no substitute: it
skips the sleep and network rules and gives a different verdict. The checker reads one line of an env file, only to
check the provider host and to scan the log for parts of the RPC URL; it sends no request. A file with the host alone
is enough, and no real URL or key is needed:

```bash
mkdir -p out
printf 'SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com\n' > out/provider-host.txt
node run_day/check_sepolia_run.js --root "$(pwd)" --env out/provider-host.txt \
  --deployment results/sepolia_v1.1_deployment.json --log results/sepolia_2026-11-12_n100.jsonl \
  --monitor <run_monitor.jsonl> --blocks-json out/verdict.json
```

With the raw monitor file, this command gave on 16 November 2026 the report of `check_final.txt` line for line (that
file was saved from PowerShell, with a byte order mark and CRLF line endings) and the verdict of `verdict_final.json`
except its `evaluated_at` time. The monitor summary in `results/run_2026-11-12/` was made from the same raw file with
`python3 results/run_2026-11-12/make_monitor_summary.py <run_monitor.jsonl> results/sepolia_2026-11-12_n100.jsonl
--out out/monitor_summary.json --md out/monitor_summary.md`.

Figures. `figures/build_all.sh` builds Figures 1 to 3 and the graphical abstract (PDF, and PNG and TIFF at 600 dpi)
into `figures/out/` or into the folder given as its argument. It reads only the four sources in `figures/` and, for
Figure 3, `results/local_2026-11-09_n100.jsonl`, whose SHA-256 it checks. It first checks that its tools are present,
and uses `sha256sum` or, if that is missing, `shasum -a 256`:

```bash
python3 -m pip install -r figures/requirements.txt
bash figures/build_all.sh out/figures
```

Figures 1 and 2 and the graphical abstract are hand-specified diagrams with no data input. Figure 3 shows only the local
log of 9 November 2026. The figure sources were redesigned for version 1.1.1, so these hashes differ from those of
version 1.1.0. On 22 November 2026 (Windows 11, TeX Live 2024 with pdfTeX 1.40.26, pdftoppm 24.03.0, Python 3.12.2,
matplotlib 3.10.5, numpy 1.26.2, Pillow 11.1.0) two builds into separate folders gave identical files, equal byte for
byte to the figures of the revised paper:

| Output | SHA-256 |
|---|---|
| `Figure_1.pdf` | `9d29f6871aeabad100e683c9db450c6badf60620cb8574bc29970bda524afba9` |
| `Figure_2.pdf` | `7faca7bb3006dd65996bf9d2ddc0df8fa39e9d30ecdb1d79f1f1e4f4f1d74d49` |
| `Figure_3.pdf` | `1ac2ccff75bd3567f79ce50cb4fe0804ca8e8328b89796dbfad85bd6676fb318` |
| `Graphical_Abstract.pdf` | `5d88f33e72bbbc052ab6dba02c82bc61c21354ae2f70518b2f808cac250d36db` |
| `Graphical_Abstract.png` | `169afc6059b7032ec44ffc8ef260ef53a6b27e4419120fd84007c9455eb1c1da` |
| `Graphical_Abstract.tif` | `15fcff35fc4f8d81a836a10cf19517c557894c95fe8e5754cc43b72dfe62d8b3` |
| `Figure_3_stats.json` | `1e289ef834457acf6e586e4d90f5d176415422053e1dddb8fa9bb5fb8fd9b4c5` |

`Figure_3_stats.json` is unchanged since version 1.1.0. Other TeX or font versions may change the PDF bytes but not the
statistics.

What is published. The timed local log of 9 November 2026; the closed Sepolia log of 12 November 2026; the deployment
record; the output of the unchanged earlier test and the log of the revised harness on the earlier code
(`results/r2.1_local_comparison/`); the run-day rules (the pre-registration addendum and the run tools) with their
manifest lines and, since version 1.1.1, the full manifest; the run checker and its tests; the final verdict, the
checker report and the analysis output; a sanitised summary of the network monitor; the figure builders; and the
transcript of the test run at the archived commit. SHA-256 values are in [`results/README.md`](results/README.md),
`run_day/MANIFEST_SUBSET.sha256`, `run_day/RUN_DAY_MANIFEST.sha256` and `FROZEN_CODE.sha256`. The full manifest has
SHA-256 `8a2ff62b04a01042e8a523a240eda58d3eb183841b46d8eb1c40803a9d22e04f`; 21 of its 23 lines can be checked
against published files, and the other two name the internal planning files below.

What is not published. The raw monitor file and the wrapper log of the run stay with the authors. They hold local
paths, the range of the default gateway and salted hashes of the gateway and the network name, and the salt was kept
on the same laptop. The other files of the run folder (the preflight report, the process list, the console and hash
notes) and the salt file are withheld for the same reason. Two
internal planning files listed in the run-day manifest and the two e-mails that carried the hashes are not published
either. The editor can ask the authors for any of these.

Default local paths. The files in `run_day/` are published byte for byte, because their SHA-256 values were fixed before
the run, so they still carry paths of the authors' laptop as default arguments and in examples: a folder in the user
profile for the live output, the authors' env file and the authors' copy of this repository. They also carry the
corresponding author's e-mail address, the recorded setup (city, phone model and carrier) and the masked range of the
default gateway (10.25.x.x), which the paper also states. No other personal data is in them. These defaults are local
paths of the authors' laptop and mean nothing elsewhere. Pass your own paths with the parameters of the PowerShell
scripts (`-Artifact`, `-EnvFile`, `-OutDir`). `run_day/tests/test_wrapper.ps1` sets the repository folder in its line 21
and takes no parameter, so it runs elsewhere only from an edited copy. No file holds a key or an RPC URL path; the test
files use fake tokens marked `TESTONLY`.

Status line and AI tools in the run-day files. `run_day/RUN_DAY_ADDENDUM_DRAFT.md` and `run_day/RUN_DAY.md` are published
byte for byte, so they still read as they did when the manifest was hashed (`run_day/RUN_DAY_MANIFEST.sha256`, SHA-256
`8a2ff62b04a01042e8a523a240eda58d3eb183841b46d8eb1c40803a9d22e04f`). The addendum therefore still calls itself a "candidate
for written user approval", and its section Q says "Pending: user's written decision". The corresponding author approved this
exact text with this manifest hash in writing, in the authors' run log, at 07:14 IST on 12 November 2026, and the e-mail that
carried the manifest hash reached the mail server at 07:18:25 IST. The run log is not published; the editor can ask for it.
"The user" in these files is the corresponding author. The AI tools Claude and Codex, named in these files, were used for
final run assistance.

## Sepolia scripts and secrets

The two Sepolia scripts run with plain Node, not through Hardhat, and no Hardhat command loads a private key.

- `measure-sepolia.js` is read-only: no signer, no transaction. It times the full verification (mode P) and the four
  contract reads sent in sequence (S), concurrently (C) and as one JSON-RPC batch (Bt), in a rotating order, at ten
  fixed times of day (machine local time). The order of the four modes depends only on the block and the iteration,
  so, when all ten blocks run (a missed block replaced in a reserve slot), the 100 timed iterations use each order 25
  times; a block run on its own keeps its orders. `--only-block` takes 1 to 10 and `--at` a time HH:MM.
  A block that cannot start within two minutes of its time, also after the machine slept, is logged as missed.
  `--pilot` runs three labelled iterations. Sockets stay open between requests for up to 10 minutes and are reused in
  turn (Node's default agent closes them after 5 s and always reuses the most recent one, so the extra connections
  of the concurrent mode would be set up again inside its timer in some orders); every row records the new sockets
  opened inside its timer. Each row carries the run's start time, and the header the commit (`git describe --dirty`).
- `deploy-sepolia.js` deploys the contract, registers an issuer DID and a subject DID with fresh Ed25519 keys, signs
  two credentials and revokes one of them with reason code 9. Each step's nonce is saved in the record first; each
  transaction is then signed, and its hash and raw form are saved before it is broadcast. A re-run looks for a receipt
  of any transaction sent for the step and otherwise broadcasts the saved one again; `--resend` signs a replacement
  with the same nonce, at the current fees or 12.5% above the last signed transaction's, whichever is higher (nodes
  refuse a replacement that pays less than 10% more), never above twice the maximum base fee plus the tip
  (`FEE_CAP_REACHED`), and whichever is mined is recorded with its own fees. A step whose nonce was saved but whose
  transaction was never signed (the run stopped first, for example on `BASE_FEE_TOO_HIGH`) is signed on a plain re-run. A failed transaction (status 0) is
  recorded and its step starts again. One run at a time (a lock file next to the record, removed by hand if a run is
  killed); a completed record is left untouched. A re-run also stops if the record
  belongs to another chain or deployer, if the code at the recorded address differs from the compiled contract, if a
  DID is controlled by another address, or if the issuer key no longer matches the recorded inputs. Only Sepolia and
  local Hardhat chains are accepted. It sets fees explicitly (a 0.01 gwei priority fee and a
  maximum fee of twice the latest base fee plus that tip; `--tip-gwei`) and stops before sending if the base fee is
  above 0.5 gwei (`--max-base-fee-gwei`). A fresh run needs 28 million gas times the highest fee it may pay (0.0283
  SepoliaETH with the defaults), so it cannot run out of funds partway.

How secrets are handled:

- The RPC URL is read from the `SEPOLIA_RPC_URL` environment variable or from that single line of the file given with
  `--env` (see [`.env.example`](.env.example)); nothing else in that file is read.
- The deployer key is a separate JSON file (`{"address": ..., "privateKey": ...}`) given with `--key`. The issuer's
  Ed25519 key is written once to `--secrets-dir` (default `~/.blockchain-did-vc-secrets`; file mode 600 on POSIX
  systems, the access rights of the user profile on Windows) and is never printed. It is needed only until the
  credentials are signed; the operator then deletes it. The script refuses a key file or secrets folder that git
  reports to be inside a working tree; if git is not installed it cannot tell. The subject's key is never stored.
- What the scripts print or log passes through one function that removes the URL and any token-like part of it (user
  information, and host labels, path segments and query values that look like keys; ordinary words such as
  `sepolia` stay) and then scans for key material; a hit stops the write. The deployment record is scanned for the
  deployer key and the URL's secret parts before every save. Errors are reduced to codes. Requests are never retried.
- The deployment record publishes credentials A and B in full. They are test credentials of the deployment's own
  DIDs; B stays valid for 365 days and, as there is no holder binding, can be presented by anyone who copies it.
- Credential B is VALID only while the deployer key is unused: its holder can revoke B or deactivate the issuer DID.
  The deployer nonce was 4 after setup and after the run (deployerNonceAfterSetup in
  results/sepolia_v1.1_deployment.json); a higher nonce means a later transaction. The key controls a test deployment
  and holds no value.

## Maintaining this repository

Do not edit or reformat the files that the paper or the deployed contract depends on; add a new file or a new version
instead:

- `contracts/DIDRegistry.sol`: its bytes, with CRLF line endings, give the deployed bytecode and metadata hash, and
  its line in the run-day manifest. A changed comment changes the metadata hash.
- The scripts in the run-day manifest: `scripts/analyze-latency.js`, `scripts/lib/rpc.js`,
  `scripts/lib/sepolia-modes.js`, `scripts/lib/stats.js` and `scripts/measure-sepolia.js`.
- The other measurement code of the freeze commit, listed in `FROZEN_CODE.sha256`: `src/vc/vc-service.js`,
  `src/vc/verifier-service.js`, `scripts/measure-local.js`, `scripts/lib/fixtures.js`, `scripts/lib/cli.js`,
  `scripts/deploy-sepolia.js`, `hardhat.config.js`, `package.json` and `package-lock.json` (so their version field
  stays 1.1.0).
- `test/`: the paper counts its 164 tests at commit `73b4cca16e7c`.
- Everything in `run_day/` (only the comment header of `MANIFEST_SUBSET.sha256` may change; its entry lines copy the
  manifest) and
  the logs, records and run outputs in `results/` and `test-transcripts/`.

Check them offline: `sha256sum run_day/RUN_DAY_MANIFEST.sha256` (8a2ff62b...), the lines of
`run_day/MANIFEST_SUBSET.sha256` and of `FROZEN_CODE.sha256` (each file states its check command; in a clone made
with core.autocrlf=true the scripts have CRLF endings and their lines do not match, so clone with
`git clone -c core.autocrlf=false`), and
`node run_day/tests/test_consistency.js "$(pwd)"`. `test/GasSchedule.test.js` parses the gas tables of this file, of
`results/README.md` and of `CHANGELOG.md`; keep their row labels ("Deployment (13,752 bytes of code)", the two
`createDID` rows and the `revokeCredential` row), or `npm test` fails with a message about gas.

How the code depends on itself (A <- B: B loads A):

- `src/vc/vc-service.js` (issue, sign, canonicalise) <- `src/vc/verifier-service.js` (B0, V1 to V8, error codes) <-
  `scripts/lib/rpc.js` (URL redaction, sockets, request counter, which imports `errorCode` from the verifier) <-
  `scripts/lib/sepolia-modes.js` (modes P, S, C, Bt) <- `scripts/measure-sepolia.js`, which also loads the verifier,
  `rpc.js` and `scripts/lib/cli.js`.
- `scripts/lib/stats.js` <- `scripts/analyze-latency.js` <- `run_day/analysis_primary.js`, which loads both by path.
- `scripts/lib/rpc.js` and `scripts/lib/sepolia-modes.js` <- `run_day/check_sepolia_run.js`; `scripts/lib/rpc.js`
  and `src/vc/verifier-service.js` <- `run_day/preflight_chain.js`. So a change in the verifier or the RPC helpers
  changes what the pre-registered run tools accept.
- `src/vc/vc-service.js` <- `scripts/lib/fixtures.js` <- `scripts/measure-gas.js`, `scripts/measure-local.js` and
  `scripts/deploy-sepolia.js`.
- `scripts/deploy-sepolia.js` is a resumable state machine (one step per transaction) with its own record file. The
  run_day files repeat the pre-registered constants (slots, dates, commit, versions, hashes) on purpose;
  `test_consistency.js` fails if one copy changes.

## Limits

- The verifier trusts the answers of its RPC provider. It checks the chain as of block N: it cannot see a change after
  N, or a reorganisation that replaces N.
- B0 does not check the format of the `eth_blockNumber` reply: a malformed reply is not rejected; the provider is
  trusted. A reply with no leading hexadecimal digit (for example "garbage" or "0x") gives `checkedAtBlock` NaN
  (written as `null` in JSON) and the reads are sent for block 0, which fail against a real chain; a provider that
  ignores the block tag can then still return `VALID`; other malformed replies are read up to their first
  non-hexadecimal character. The verifier does not check `eth_chainId` or the code at the registry address.
- The verifier is stateless and sequential: each credential costs one `eth_blockNumber` and four `eth_call` requests
  (about 0.6 s on Sepolia over one provider in the paper's run, so about 1.6 credentials per second per worker). It
  does not share the issuer reads between credentials, and no throughput or provider rate-limit test was made.
- The verifier sets no length limit on the unauthenticated `issuer`, `credentialSubject.id`, `id` and
  `proof.verificationMethod`; the issuer and subject identifiers are sent to the provider at V2, V3 and V5 before the
  signature is checked, so a presenter can make the verifier send large requests.
- Dates: `validFrom` and `validUntil` take a date, a time and a time zone as accepted by JavaScript Date.parse; the
  check does not enforce the XML Schema limits for year 0000 or for offsets beyond 14:00.
- `issueCredential` builds `credentialSubject` as `{ id: subjectDid, ...claims }`, so a claim named `id` replaces the
  subject DID; do not pass `id` among the claims.
- The RPC helpers accept an `http://` URL for any host, so an API key in the URL would travel unencrypted; use an
  `https://` URL.
- `measure-sepolia.js` schedules its ten blocks (08:00 to 20:00) in the machine's local time, although its header
  calls the schedule IST; run it on a machine set to IST (UTC+05:30) to repeat the paper's schedule. The header row
  of the log records `timezoneOffsetMinutes`.
- Everything the registry stores is public: DID documents, controllers, delegates, attributes and revocation entries
  with their reason codes.
- `did:smid` is this artifact's method name. It has no method specification and is not in the W3C list of DID methods,
  and no DID resolver driver exists for it.
- A DID name proves nothing by itself. `createDID` registers any unused name for whoever calls it first, and
  a handover needs the new address's acceptance but no other check. `VALID` means that
  the credential was signed with a key in the document of an active registered DID; which issuer DIDs to trust is the
  relying party's decision, outside the verifier.
- The registry has no `assertionMethod` relationship: any verification method of the issuer's document can sign
  credentials.
- `rotateKey` and `updateDID` store the string they are given. The verifier reads each entry as the JSON of a
  verification method, so pass the whole JSON (id, type, controller, publicKeyMultibase), not the bare key; an entry
  that is not that JSON makes every credential of the DID fail at V5.
- Administrators can pause the registry for as long as they like. A pause also stops key rotation, controller changes
  and reactivation, so during a pause the only remedy for a leaked key is to deactivate the DID. The owner can never be
  removed or replaced, so a compromised owner key can keep these functions paused.
- `deactivateDID` can be called again on a deactivated DID: it emits a second `DIDDeactivated` and moves `updated`.
  `addAdmin` and `removeAdmin` emit their events also when nothing changes, so read `isAdmin` for the state.
- Delegates are recorded but grant no permission in this contract.
- `nonces(address)` is never written and returns 0; the per-DID nonce is a change counter that no function checks.
  Neither is replay protection, although comments in the contract call them so.
- An address's list of DIDs grows only through its own actions (creating a DID or accepting one). The address that
  accepts a handover pays for a search through the previous controller's list, which grows with that list.
- A handover proposal does not expire. It survives `updateDID`, `rotateKey`, revocations and a pause, and ends only
  when it is accepted, replaced, cancelled or the DID is deactivated; a proposal forgotten long ago can still be
  accepted, also by whoever has since obtained the proposed address's key. A two-step handover does not protect
  against a stolen controller key, whose holder can propose and accept an address of their own. After a handover the
  DID keeps its delegates and attributes, and the new controller can revoke every credential issued under the DID,
  including those issued before the handover.
- A handover moves control of the registry record only. It does not rotate the verification methods, so a former
  controller that still holds the issuer's signing key can keep issuing credentials that verify until the new
  controller calls rotateKey.
- `rotateKey` replaces one entry of the verification methods, so a key listed twice stays usable through the other
  entry.
- No test covers removeAdmin(owner), reactivateDID on an active DID, the empty-identifier check, or the delegate and
  attribute success paths; the first three were checked by hand.
- The test "Should use reasonable gas for DID creation" uses the version 1.0.0 placeholder inputs and a loose bound;
  the exact gas is pinned by `GasSchedule.test.js`. The run-day tests and the mutation run in `run_day/tests/` are not
  part of `npm test`.
- `scripts/lib/stats.js` is meant for logs of up to a few thousand rows: the interval computation grows quadratically
  (0.2 s at 10,000 rows, 18 s at 50,000) and the minimum and maximum fail above about 125,000 rows.
- Dependencies: the locked toolchain (Hardhat 2.29.0, ethers 5.8.0) was frozen for the measurements and has not been
  updated. On 22 November 2026 `npm audit --omit=dev` reported 15 vulnerable packages (12 low, 2 moderate, 1 high)
  in the run-time dependency ethers 5.8.0 and its packages, all from three advisories: GHSA-848j-6mx2-7j84 (low) in
  `elliptic` 6.6.1 and GHSA-58qx-3vcg-4xpx (moderate) and GHSA-96hv-2xvq-fx4p (high) in `ws` 8.18.0, which ethers
  loads for its WebSocket provider; this artifact uses JSON-RPC over HTTP(S) and never WebSocket. `npm audit` for
  the whole tree reported 69 vulnerable packages (28 low, 23 moderate, 15 high, 3 critical) from 66 advisories, the
  others in development tools. The fixes npm offers need major upgrades.
- The contract has not been audited by a third party.

## Standards

- W3C Decentralized Identifiers (DIDs) v1.0: the data model of the stored documents.
- W3C Verifiable Credentials Data Model v2.0: the credential format; `validFrom` and `validUntil` as in section 4.9.
- W3C Data Integrity EdDSA Cryptosuites v1.0: `eddsa-jcs-2022`, sections 3.3.1 and 3.3.2; test vector B.3.
- W3C Controlled Identifiers v1.0: Multikey encoding of Ed25519 keys (`0xed01` public, `0x8026` secret, base58btc).
- RFC 8785 (JSON Canonicalization Scheme), RFC 8032 (Ed25519), RFC 5280 section 5.3.1 (reason codes).

## Citing

Please cite the archived release of version 1.1.1, DOI
[10.5281/zenodo.24451811](https://doi.org/10.5281/zenodo.24451811), or use [`CITATION.cff`](CITATION.cff). The concept DOI
[10.5281/zenodo.21515957](https://doi.org/10.5281/zenodo.21515957) stands for all versions and resolves to the newest.
Once the paper is published, please cite the paper as the primary reference. Version 1.1.0 (DOI
[10.5281/zenodo.24263442](https://doi.org/10.5281/zenodo.24263442)) has the same contract, code, tests and logs;
version 1.0.0 (DOI 10.5281/zenodo.21515958) is superseded. The Zenodo record is authoritative for the metadata
(authors, affiliations, licence, related identifiers); `.zenodo.json` copies it, and `CITATION.cff` gives the
affiliations as on the paper's title page.

## Contact

Questions and defects: open an issue at https://github.com/Vineeta-Rathore/blockchain-did-vc/issues. The corresponding
author's address is the one on the paper's title page.

## Licence

The code, the logs and results, the figure sources and the documentation are released under the MIT licence, see
[`LICENSE`](LICENSE), unless a file says otherwise; the W3C test vector named below is not covered by it.

`test/fixtures/eddsa-jcs-2022-B3.json` reproduces the example key pair, document, proof options and expected values of
appendix B.3 (Representation: eddsa-jcs-2022) of the W3C Recommendation "Data Integrity EdDSA Cryptosuites v1.0" of
15 May 2025, https://www.w3.org/TR/2025/REC-vc-di-eddsa-20250515/, Copyright (c) 2025 World Wide Web Consortium,
used under the W3C Software and Document Notice and License (https://www.w3.org/copyright/software-license-2023/).
The key in it is the specification's published test key, not a secret.
