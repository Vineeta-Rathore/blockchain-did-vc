# Decentralised Identifier-Anchored Verifiable Credentials with On-Chain Revocation for Social Media Identity Management

Reference implementation for the paper of the same title (V. Rathore and M. K. Rawat). It contains an Ethereum
registry of DID documents with per-credential revocation keyed by the issuer DID, a Node.js service that issues W3C
Verifiable Credentials with `eddsa-jcs-2022` proofs, a verifier that checks a credential against the registry, and the
scripts and raw logs behind the paper's measurements. It covers the DID and credential layers only; it does not
implement verifiable presentations, holder binding or zero-knowledge selective disclosure.

This is version 1.1.0. What changed since version 1.0.0 is listed in [`CHANGELOG.md`](CHANGELOG.md).

## Contents

- [Versions and contracts](#versions-and-contracts)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Repository layout](#repository-layout)
- [The registry](#the-registry)
- [Issuing and verifying credentials](#issuing-and-verifying-credentials)
- [Gas on two schedules](#gas-on-two-schedules)
- [Reproducing the numbers](#reproducing-the-numbers)
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
| 1.1.0 | (to be added: address and deployment date) | `revokeCredential(string,string,uint8)`; event `CredentialRevoked(string indexed didId, string indexed credentialId, uint8 reasonCode, uint256 timestamp)` | `results/sepolia_v1.1_deployment.json`, the logs named in [`results/README.md`](results/README.md) |
| 1.0.0 (superseded) | `0x5f9017208f3F4A97657E2b32BE433a2641DFEF07`, created 21 July 2026 | `revokeCredential(string,string,string)`; event `CredentialRevoked(string indexed didId, string indexed credentialId, string reason, uint256 timestamp)` | `results/sepolia_2026-07-21_n20.jsonl` |

The ABI of version 1.1.0 is in `artifacts/contracts/DIDRegistry.sol/DIDRegistry.json` after `npx hardhat compile`.
The ABI of version 1.0.0 comes from `contracts/DIDRegistry.sol` at commit `4b0519c`. The version 1.0.0 contract on
Sepolia was compiled with solc 0.8.24, not with the 0.8.19 set in this repository, so a compile from this repository
does not reproduce its bytecode; its interface is the version 1.0.0 ABI ([`results/README.md`](results/README.md)).

## Requirements

- Node.js 20 or later (Hardhat's simulator, EDR, needs it) and npm. Tested with Node.js 22.10.0 and npm 10.9.0 on
  Windows 11.
- Python 3 with numpy, only for `scripts/check_stats_numpy.py`, and with matplotlib, only for
  `scripts/plot-latency.py` (tested with Python 3.12 and matplotlib 3.10.5).
- For the Sepolia scripts only: an Ethereum Sepolia JSON-RPC endpoint; for `deploy-sepolia.js` also a funded Sepolia
  test key (never a key that holds real funds).

## Quick start

```bash
npm ci                 # install the locked toolchain (Hardhat 2.29.0, ethers 5.8.0)
npx hardhat compile    # solc 0.8.19, optimiser on, 200 runs
npm test               # 110 tests
npm run measure-gas    # gas of each operation, on the osaka schedule and on Sepolia's
```

`npm test` runs five suites: the registry (43 tests), credentials and verification (45), leak tests (14), the RPC
helpers' secret handling (6) and the gas model (2). The leak tests run every measurement mode, and both Sepolia
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
```

## The registry

`contracts/DIDRegistry.sol` stores each DID document on chain: its identifier, controller address, verification
methods, authentication methods, services, creation and update times, an `active` flag, a hash of the full document
and a nonce. The controller of a DID can update the document, rotate a key, change the controller, add or remove
delegates, set attributes, deactivate and reactivate the DID, and revoke credentials that the DID issued.

Revocation is keyed by the issuer DID and the credential ID: `revokeCredential(issuerDid, credentialId, reasonCode)`
can be called only by the controller of `issuerDid`, and a revocation is final. The entry stores the time and a reason
code from RFC 5280, section 5.3.1:

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

Rejected codes revert with "DIDRegistry: Invalid reason code". The reason code is public, like everything else the
registry stores.

Administration. The deploying account becomes `owner` and the first administrator. Administrators can add and remove
administrators (not the owner) and pause or unpause the registry; each of these actions emits an event (`AdminAdded`,
`AdminRemoved`, `Paused`, `Unpaused`). While the registry is paused, `createDID`, `updateDID`, `reactivateDID`,
`changeController`, `rotateKey`, `addDelegate`, `removeDelegate` and `setAttribute` revert; `revokeCredential`,
`deactivateDID` and every read function keep working, so a pause cannot stop an issuer from revoking or a controller
from deactivating a DID. No administrator function changes, revokes or deactivates another controller's DID or
credentials. The contract has no upgrade mechanism and no function that transfers ownership.

A deactivated DID can still have a key rotated or its document updated (to repair it before reactivation); it stays
deactivated until its controller reactivates it. A key rotation also replaces the old key in the authentication
methods, and `updateDID` sets the authentication methods to the new verification methods.

## Issuing and verifying credentials

`src/vc/vc-service.js` issues credentials in the W3C Verifiable Credentials Data Model 2.0 with an `eddsa-jcs-2022`
Data Integrity proof (Ed25519 keys in Multikey encoding). Following section 3.3.1 of the cryptosuite specification,
the credential's `@context` is copied into the proof before the proof configuration is hashed; the W3C test vector
(appendix B.3): a test reproduces its proof value. Credentials signed by version 1.0.0, whose proofs have no
`@context`, still verify.

`src/vc/verifier-service.js` checks a credential in the order below and stops at the first failure:

| Step | Check | Result if it fails |
|---|---|---|
| V1 | `@context` starts with the VC 2.0 base context and `type` includes `VerifiableCredential`; `id` (a non-empty string, because revocation is keyed by it), `issuer`, `credentialSubject.id` and `proof.verificationMethod` are present; the VC 1.1 properties `issuanceDate` and `expirationDate` are absent; `validFrom` and `validUntil`, if present, are date-time stamps with a time zone and `validUntil` is not earlier than `validFrom` | `MALFORMED_CREDENTIAL`, `MISSING_PROOF` |
| B0 | read the newest block number N (or use the caller's block number, an integer 0 or more) | `VERIFICATION_ERROR` |
| V2 | the issuer DID exists and is active at block N | `ISSUER_DID_INACTIVE_OR_UNKNOWN` |
| V3 | the subject DID exists and is active at block N | `SUBJECT_DID_INACTIVE_OR_UNKNOWN` |
| V4 | `validFrom` is not later than now plus the clock tolerance (default 60 s); `validUntil` is later than now | `CREDENTIAL_NOT_YET_VALID`, `CREDENTIAL_EXPIRED` |
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
| Deployment (12,685 bytes of code) | 2,838,630 | 20,042,702 | 2 |
| `createDID`, a controller's first DID | 863,141 | 4,111,181 | 37 |
| `createDID`, a controller's second DID | 689,311 | 3,240,891 | 29 |
| `revokeCredential` (45-character credential ID, reason code 9) | 145,713 | 579,513 | 5 |

The Glamsterdam column is computed by `scripts/lib/gas-schedule.js` from the storage writes of each local
transaction. It matched the gas that Sepolia reported for the same calls (`eth_simulateV1`, 8 November 2026)
exactly; `test/GasSchedule.test.js` checks this. The three EIPs were in Last Call at that date and may still change
before they reach mainnet. The gas of the actual Sepolia deployment is in `results/sepolia_v1.1_deployment.json`
(to be added).

## Reproducing the numbers

| Number | Command | Source |
|---|---|---|
| Test count | `npm test` | console |
| Gas, both schedules | `npm run measure-gas` | console (JSON) |
| Gas for the deployment's own inputs | `GAS_INPUTS=results/sepolia_v1.1_deployment.json npx hardhat run scripts/measure-gas.js` | console (JSON) |
| Local verification latency | five runs of `LOCAL_LOG=results/local_<date>_n100.jsonl PROCESS_INDEX=<k> npx hardhat run scripts/measure-local.js`, k = 1 to 5, then `node scripts/analyze-latency.js <log>` | `results/local_<date>_n100.jsonl` (to be added) |
| Sepolia verification latency | `node scripts/measure-sepolia.js --deployment results/sepolia_v1.1_deployment.json --log <log> --env <file>`, then `node scripts/analyze-latency.js <log>` | `results/sepolia_<date>_n100.jsonl` (to be added) |
| Latency figure | `python scripts/plot-latency.py <local log>` | (to be added) |
| July 2026 figures (version 1.0.0) | `node scripts/analyze-latency.js results/sepolia_2026-07-21_n20.jsonl` | `results/sepolia_2026-07-21_n20.jsonl` |
| Statistics against numpy | `python scripts/check_stats_numpy.py` | console |

On Windows PowerShell, set the variables first: `$env:LOCAL_LOG = "results/local_<date>_n100.jsonl";
$env:PROCESS_INDEX = "1"; npx hardhat run scripts/measure-local.js`.

`scripts/lib/stats.js` defines every statistic once: the conventional median, quartiles by the Hyndman and Fan type 7
rule, the nearest-rank 95th percentile, an order-statistic confidence interval for the median, and a seeded percentile
bootstrap for paired speed-ups only. Each log, and what produced it, is described in
[`results/README.md`](results/README.md).

## Sepolia scripts and secrets

The two Sepolia scripts run with plain Node, not through Hardhat, and no Hardhat command loads a private key.

- `measure-sepolia.js` is read-only: no signer, no transaction. It times the full verification (mode P) and the four
  contract reads sent in sequence (S), concurrently (C) and as one JSON-RPC batch (Bt), in a rotating order, at ten
  fixed times of day (machine local time). `--pilot` runs three labelled iterations.
- `deploy-sepolia.js` deploys the contract, registers an issuer DID and a subject DID with fresh Ed25519 keys, signs
  two credentials and revokes one of them with reason code 9. Each step's nonce is saved in the record before its
  transaction is sent, and the hash right after; a re-run waits for that transaction, or sends the step again with the
  same nonce (`--resend`, to replace a stuck one), which the chain accepts only once. A re-run also stops if the record
  belongs to another chain or deployer, if the code at the recorded address differs from the compiled contract, if a
  DID is controlled by another address, or if the issuer key no longer matches the recorded inputs. Only Sepolia and
  local Hardhat chains are accepted. It sets fees explicitly (a 0.01 gwei priority fee and a
  maximum fee of twice the latest base fee plus that tip; `--tip-gwei`) and stops before sending if the base fee is
  above 1 gwei (`--max-base-fee-gwei`).

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
  `changeController` hands a DID to another address in one step, without that address's consent. `VALID` means that
  the credential was signed with a key in the document of an active registered DID; which issuer DIDs to trust is the
  relying party's decision, outside the verifier.
- The registry has no `assertionMethod` relationship: any verification method of the issuer's document can sign
  credentials.
- Administrators can pause the registry for as long as they like. A pause also stops key rotation, controller changes
  and reactivation, so during a pause the only remedy for a leaked key is to deactivate the DID. The owner can never be
  removed or replaced, so a compromised owner key can keep these functions paused.
- Delegates are recorded but grant no permission in this contract.
- Anyone can add DIDs to another address's list by transferring them to it, which makes later transfers by that
  address more expensive. `rotateKey` replaces one entry of the verification methods, so a key listed twice stays
  usable through the other entry.
- The contract has not been audited by a third party.

## Standards

- W3C Decentralized Identifiers (DIDs) v1.0: the data model of the stored documents.
- W3C Verifiable Credentials Data Model v2.0: the credential format; `validFrom` and `validUntil` as in section 4.9.
- W3C Data Integrity EdDSA Cryptosuites v1.0: `eddsa-jcs-2022`, sections 3.3.1 and 3.3.2; test vector B.3.
- W3C Controlled Identifiers v1.0: Multikey encoding of Ed25519 keys (`0xed01` public, `0x8026` secret, base58btc).
- RFC 8785 (JSON Canonicalization Scheme), RFC 8032 (Ed25519), RFC 5280 section 5.3.1 (reason codes).

## Citing

Please cite the archived release of version 1.1.0 (DOI to be added) or use [`CITATION.cff`](CITATION.cff). Once the
paper is published, please cite the paper as the primary reference. Version 1.0.0 (DOI 10.5281/zenodo.21515958) is
superseded by this version.

## Licence

MIT, see [`LICENSE`](LICENSE).
