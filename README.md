# Decentralised Identifier-Anchored Verifiable Credentials with On-Chain Revocation for Social Media Identity Management

Reference implementation for the paper of the same title (V. Rathore and M. K. Rawat). It contains an Ethereum
registry of DID documents with per-credential revocation keyed by the issuer DID, a Node.js service that issues W3C
Verifiable Credentials with `eddsa-jcs-2022` proofs, a verifier that checks a credential against the registry, and the
scripts and raw logs behind the paper's measurements. It covers the DID and credential layers only; it does not
implement verifiable presentations, holder binding or zero-knowledge selective disclosure.

This is version 1.1.0 (DOI [10.5281/zenodo.24263442](https://doi.org/10.5281/zenodo.24263442)). What changed since
version 1.0.0 is listed in [`CHANGELOG.md`](CHANGELOG.md). The measurement code was frozen at commit `73b4cca16e7c`
before the Sepolia run of 12 November 2026; the logs, the run tools and the figure builders were added after the run,
without changing that code.

## Contents

- [Versions and contracts](#versions-and-contracts)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Repository layout](#repository-layout)
- [The registry](#the-registry)
- [Issuing and verifying credentials](#issuing-and-verifying-credentials)
- [Gas on two schedules](#gas-on-two-schedules)
- [Reproducing the numbers](#reproducing-the-numbers)
- [Reproducing the paper's numbers and figures](#reproducing-the-papers-numbers-and-figures)
- [Sepolia scripts and secrets](#sepolia-scripts-and-secrets)
- [Limits](#limits)
- [Standards](#standards)
- [Citing](#citing)
- [Licence](#licence)

## Versions and contracts

The revocation function and its event changed in version 1.1.0, so each contract must be called with the ABI of its
own version.

| Version | Contract on Ethereum Sepolia (chain ID 11155111) | Revocation interface | Measurements |
|---|---|---|---|
| 1.1.0 | `0x625eD772F70199BAc1A33A3BAF49B7394bBb5FC2`, created 9 November 2026 (block 12,099,140) | `revokeCredential(string,string,uint8)`; event `CredentialRevoked(string indexed didId, string indexed credentialId, uint8 reasonCode, uint256 timestamp)` | `results/sepolia_v1.1_deployment.json`, the logs named in [`results/README.md`](results/README.md) |
| 1.0.0 (superseded) | `0x5f9017208f3F4A97657E2b32BE433a2641DFEF07`, created 21 July 2026 | `revokeCredential(string,string,string)`; event `CredentialRevoked(string indexed didId, string indexed credentialId, string reason, uint256 timestamp)` | `results/sepolia_2026-07-21_n20.jsonl` |

The ABI of version 1.1.0 is in `artifacts/contracts/DIDRegistry.sol/DIDRegistry.json` after `npx hardhat compile`.
The ABI of version 1.0.0 comes from `contracts/DIDRegistry.sol` at commit `4b0519c`. The version 1.0.0 contract on
Sepolia was compiled with solc 0.8.24, not with the 0.8.19 set in this repository, so a compile from this repository
does not reproduce its bytecode; its interface is the version 1.0.0 ABI ([`results/README.md`](results/README.md)).

## Requirements

- Node.js 20 or later (Hardhat's simulator, EDR, needs it; `engines` in `package.json`) and npm. Tested with Node.js 22.10.0 and npm 10.9.0 on
  Windows 11.
- Python 3 with numpy, only for `scripts/check_stats_numpy.py`, and with matplotlib, only for
  `scripts/plot-latency.py`: `python3 -m pip install -r requirements.txt` (numpy 1.26.2, matplotlib 3.10.5; tested
  with Python 3.12.2). On Windows the command is `python` or `py -3`; the commands below write `python3`.
- For the Sepolia scripts only: an Ethereum Sepolia JSON-RPC endpoint; for `deploy-sepolia.js` also a funded Sepolia
  test key (never a key that holds real funds). The run checker and the analysis of the published logs need no
  endpoint and send no request.
- For the figures only: pdflatex, pdfinfo, pdffonts and pdftoppm (tested with TeX Live 2024) and the Python packages
  in `figures/requirements.txt`; on Windows, `bash` from Git for Windows.

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
  GasSchedule.test.js          the Sepolia gas model against values observed on Sepolia
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
  lib/                         statistics, fixtures, gas model, RPC helpers, measurement modes
results/
  README.md                    what each log measured, with which script, contract and version
  *.jsonl, *.json              raw logs and the deployment record
  run_2026-11-12/              verdict, checker report and analysis of the Sepolia run; monitor summary and its script
  r2.1_local_comparison/       the earlier test and the revised harness, both run on the version 1.0.0 code
run_day/                       the rules and tools of the Sepolia run, as fixed before it (byte for byte)
  MANIFEST_SUBSET.sha256       the manifest lines of the published run-day files
  tests/                       tests of the run checker and of the run tools
figures/                       builders of Figures 1 to 3 and of the graphical abstract (output in figures/out/)
test-transcripts/              the npm test run at the archived commit 73b4cca
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
the credential's `@context` is copied into the proof before the proof configuration is hashed; the W3C test vector
(appendix B.3): a test reproduces its proof value. Credentials signed by version 1.0.0, whose proofs have no
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
// { valid, reason, issuerDid, subjectDid, credentialId, checkedAt, checkedAtBlock, timings? }
```

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

## Reproducing the numbers

| Number | Command | Source |
|---|---|---|
| Test count | `npm test` | console |
| Gas, both schedules | `npm run measure-gas` | console (JSON) |
| Gas for the deployment's own inputs | `GAS_INPUTS=results/sepolia_v1.1_deployment.json npx hardhat run scripts/measure-gas.js` | console (JSON) |
| Local verification latency | five runs of `LOCAL_LOG=results/local_<date>_n100.jsonl PROCESS_INDEX=<k> npx hardhat run scripts/measure-local.js`, k = 1 to 5, then `node scripts/analyze-latency.js <log>` | `results/local_2026-11-09_n100.jsonl` |
| Sepolia verification latency | `node scripts/measure-sepolia.js --deployment results/sepolia_v1.1_deployment.json --log <log> --env <file>`, then `node scripts/analyze-latency.js <log>` | `results/sepolia_2026-11-12_n100.jsonl` |
| Sepolia analysis of the paper | `node run_day/analysis_primary.js ...` (see the next section) | `results/run_2026-11-12/analysis_primary_output.txt` |
| Latency figure, quick plot | `python3 scripts/plot-latency.py results/local_2026-11-09_n100.jsonl --out <file.pdf> --expect-n 100` | the file given with `--out` |
| Figures of the paper | `bash figures/build_all.sh` (see the next section) | `figures/out/` |
| July 2026 figures (version 1.0.0) | `node scripts/analyze-latency.js results/sepolia_2026-07-21_n20.jsonl` | `results/sepolia_2026-07-21_n20.jsonl` |
| Statistics against numpy | `python3 scripts/check_stats_numpy.py` | console |

On Windows PowerShell, set the variables first: `$env:LOCAL_LOG = "results/local_<date>_n100.jsonl";
$env:PROCESS_INDEX = "1"; npx hardhat run scripts/measure-local.js`. Variables set this way stay set for the whole
PowerShell session: remove them afterwards (`Remove-Item Env:LOCAL_LOG, Env:PROCESS_INDEX, Env:GAS_INPUTS`), because
a leftover `GAS_INPUTS` switches `npm run measure-gas` to replay mode and a leftover `PROCESS_INDEX` repeats a
process index (which `analyze-latency.js` reports).

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

## Reproducing the paper's numbers and figures

Every command runs from the repository root and works offline. The commands are written for `bash`; in PowerShell,
write `(Get-Location).Path` for `"$(pwd)"`. The run-day scripts need `--root` as an absolute path.

Tests. `npm test` runs the 164 tests; `test-transcripts/npm_test_73b4cca_2026-11-15.txt` is the run at the archived
commit (164 passing, exit 0). The run checker and the run tools have their own tests:

```bash
node run_day/tests/test_consistency.js "$(pwd)"
node run_day/tests/test_check_sepolia_run.js "$(pwd)" "$(pwd)/results/sepolia_v1.1_deployment.json"
```

The first gives 55 checks and the second 301 scenarios (about three minutes); both make their own fake inputs. One
consistency check compares `contracts/DIDRegistry.sol` with the hash of the authors' Windows checkout, which has CRLF
line endings, so on a checkout with LF line endings that one check fails (see `run_day/MANIFEST_SUBSET.sha256`).

Analysis of the Sepolia run. This reads the closed log and the final verdict and writes the tables of the paper:

```bash
node run_day/analysis_primary.js --root "$(pwd)" --log results/sepolia_2026-11-12_n100.jsonl \
  --verdict results/run_2026-11-12/verdict_final.json --out analysis_summary.json > analysis_primary_output.txt
```

Both outputs equal `results/run_2026-11-12/analysis_primary_output.txt` and `analysis_summary.json` byte for byte
(checked on 16 November 2026 with Node.js 22.10.0 on Windows 11).

The run checker. `run_day/check_sepolia_run.js` wrote `results/run_2026-11-12/verdict_final.json` and
`check_final.txt` from the log, the deployment record and the raw monitor file. The raw monitor file is not published,
so the verdict cannot be recomputed from this repository. Running the checker with `--no-monitor` is no substitute: it
skips the sleep and network rules and gives a different verdict. The checker reads one line of an env file, only to
check the provider host and to scan the log for parts of the RPC URL; it sends no request. A file with the host alone
is enough, and no real URL or key is needed:

```bash
printf 'SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com\n' > .env.provider-host
node run_day/check_sepolia_run.js --root "$(pwd)" --env .env.provider-host \
  --deployment results/sepolia_v1.1_deployment.json --log results/sepolia_2026-11-12_n100.jsonl \
  --monitor <run_monitor.jsonl> --blocks-json verdict.json
```

With the raw monitor file, this command gave on 16 November 2026 the report of `check_final.txt` line for line (that
file was saved from PowerShell, with a byte order mark and CRLF line endings) and the verdict of `verdict_final.json`
except its `evaluated_at` time. The monitor summary in `results/run_2026-11-12/` was made from the same raw file with
`python3 results/run_2026-11-12/make_monitor_summary.py <run_monitor.jsonl> results/sepolia_2026-11-12_n100.jsonl
--out monitor_summary.json --md monitor_summary.md`.

Figures. `figures/build_all.sh` builds Figures 1 to 3 and the graphical abstract into `figures/out/` (or a folder
given as its argument). It reads only the four sources in `figures/` and, for Figure 3,
`results/local_2026-11-09_n100.jsonl`, whose SHA-256 it checks:

```bash
python3 -m pip install -r figures/requirements.txt
bash figures/build_all.sh
```

Figures 1 and 2 and the graphical abstract are hand-specified diagrams with no data input. Figure 3 shows only the local
log of 9 November 2026. On 16 November 2026 (Windows 11, TeX Live 2024, Python 3.12.2, matplotlib 3.10.5) the build
gave the submitted files byte for byte:

| Output | SHA-256 |
|---|---|
| `Figure_1.pdf` | `0fefcc40d1ba7f974a2f1e17b03b3e6be877d9736583c78f94c899b13f924636` |
| `Figure_2.pdf` | `86052bc41593626da38707e246d2095c67f8f5302f699e3691b3a27b5617ca7f` |
| `Figure_3.pdf` | `b78ed8c0efd321807355ecdb235ef04ac9b4302eb5158b3e96081b2b798d6484` |
| `Graphical_Abstract.pdf` | `915ba31a8ef4a0a65808fa4616aea887047ceea04878152bd39e6d6d0b553475` |
| `Graphical_Abstract.png` | `8d586ec585a4313168d50cdfd5fb020070390ba396d3564525eb5f78340eac40` |
| `Figure_3_stats.json` | `1e289ef834457acf6e586e4d90f5d176415422053e1dddb8fa9bb5fb8fd9b4c5` |

`Figure_3_stats.json` is now written with LF line endings; apart from that it equals the file written for the
submission. Other TeX or font versions may change the PDF bytes but not the statistics.

What is published. The timed local log of 9 November 2026; the closed Sepolia log of 12 November 2026; the deployment
record; the output of the unchanged earlier test and the log of the revised harness on the earlier code
(`results/r2.1_local_comparison/`); the run-day rules (the pre-registration addendum and the run tools) with their
manifest lines; the run checker and its tests; the final verdict, the checker report and the analysis output; a
sanitised summary of the network monitor; the figure builders; and the transcript of the test run at the archived
commit. SHA-256 values are in [`results/README.md`](results/README.md) and `run_day/MANIFEST_SUBSET.sha256`.

What is not published. The raw monitor file and the wrapper log of the run stay with the authors. They hold local
paths, the range of the default gateway and salted hashes of the gateway and the network name, and the salt was kept
on the same laptop. The other files of the run folder (the preflight report, the process list, the console and hash
notes) and the salt file are withheld for the same reason. Two
internal planning files listed in the run-day manifest and the two e-mails that carried the hashes are not published
either. The editor can ask the authors for any of these.

Default local paths. The files in `run_day/` are published byte for byte, because their SHA-256 values were fixed before
the run, so they still carry paths of the authors' laptop as default arguments and in examples: a folder in the user
profile for the live output, the authors' env file and the authors' copy of this repository. These defaults are local
paths of the authors' laptop and mean nothing elsewhere. Pass your own paths with the parameters of the PowerShell
scripts (`-Artifact`, `-EnvFile`, `-OutDir`). `run_day/tests/test_wrapper.ps1` sets the repository folder in its line 21
and takes no parameter, so it runs elsewhere only from an edited copy. No file holds a key or an RPC URL path; the test
files use fake tokens marked `TESTONLY`.

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
  Ed25519 key is written once to `--secrets-dir` (default `~/.blockchain-did-vc-secrets`, file mode 600) and never
  printed; it is needed only until the credentials are signed, and is deleted after the deployment. The subject's key
  is never stored. The script refuses a key file or secrets folder inside a git working tree.
- What the scripts print or log passes through one function that removes the URL and any token-like part of it (user
  information, and host labels, path segments and query values that look like keys; ordinary words such as
  `sepolia` stay) and then scans for key material; a hit stops the write. The deployment record is scanned for the
  deployer key and the URL's secret parts before every save. Errors are reduced to codes. Requests are never retried.
- The deployment record publishes credentials A and B in full. They are test credentials of the deployment's own
  DIDs; B stays valid for 365 days and, as there is no holder binding, can be presented by anyone who copies it.

## Limits

- The verifier trusts the answers of its RPC provider. It checks the chain as of block N: it cannot see a change after
  N, or a reorganisation that replaces N.
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
- Administrators can pause the registry for as long as they like. A pause also stops key rotation, controller changes
  and reactivation, so during a pause the only remedy for a leaked key is to deactivate the DID. The owner can never be
  removed or replaced, so a compromised owner key can keep these functions paused.
- Delegates are recorded but grant no permission in this contract.
- An address's list of DIDs grows only through its own actions (creating a DID or accepting one). The address that
  accepts a handover pays for a search through the previous controller's list, which grows with that list.
- A handover proposal does not expire. It survives `updateDID`, `rotateKey`, revocations and a pause, and ends only
  when it is accepted, replaced, cancelled or the DID is deactivated; a proposal forgotten long ago can still be
  accepted, also by whoever has since obtained the proposed address's key. A two-step handover does not protect
  against a stolen controller key, whose holder can propose and accept an address of their own. After a handover the
  DID keeps its delegates and attributes, and the new controller can revoke every credential issued under the DID,
  including those issued before the handover.
- `rotateKey` replaces one entry of the verification methods, so a key listed twice stays usable through the other
  entry.
- The contract has not been audited by a third party.

## Standards

- W3C Decentralized Identifiers (DIDs) v1.0: the data model of the stored documents.
- W3C Verifiable Credentials Data Model v2.0: the credential format; `validFrom` and `validUntil` as in section 4.9.
- W3C Data Integrity EdDSA Cryptosuites v1.0: `eddsa-jcs-2022`, sections 3.3.1 and 3.3.2; test vector B.3.
- W3C Controlled Identifiers v1.0: Multikey encoding of Ed25519 keys (`0xed01` public, `0x8026` secret, base58btc).
- RFC 8785 (JSON Canonicalization Scheme), RFC 8032 (Ed25519), RFC 5280 section 5.3.1 (reason codes).

## Citing

Please cite the archived release of version 1.1.0, DOI
[10.5281/zenodo.24263442](https://doi.org/10.5281/zenodo.24263442), or use [`CITATION.cff`](CITATION.cff). Once the
paper is published, please cite the paper as the primary reference. Version 1.0.0 (DOI 10.5281/zenodo.21515958) is
superseded by this version.

## Licence

MIT, see [`LICENSE`](LICENSE).
