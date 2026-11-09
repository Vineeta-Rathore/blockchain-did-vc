# Changelog

## 1.1.0 (release date to be added)

### Registry (`contracts/DIDRegistry.sol`)

These changes alter the interface, so version 1.0.0 clients cannot call a version 1.1.0 contract unchanged.

- `revokeCredential(string,string,string)` is now `revokeCredential(string,string,uint8)`: a reason code from
  RFC 5280, section 5.3.1, replaces the free-text reason. Codes 0-5, 9 and 10 are accepted; 6, 7, 8 and values above
  10 revert with "DIDRegistry: Invalid reason code". The `CredentialRevoked` event and the entry returned by
  `getRevocationEntry` carry `uint8 reasonCode` instead of `string reason`.
- `pause()` no longer blocks `revokeCredential` or `deactivateDID`.
- `rotateKey` and `updateDID` also work on a deactivated DID, which stays deactivated (repair before reactivation).
- A handover takes two steps: `changeController` records a proposal (`ControllerChangeProposed`), and control moves
  when the proposed address calls the new `acceptController` (`ControllerChanged`). New: `cancelControllerChange`
  (also while paused; `ControllerChangeCancelled`) and `getPendingController`. Deactivation withdraws a pending
  proposal; a proposal that replaces another emits `ControllerChangeCancelled` for the address it replaces. In
  version 1.0.0, `changeController` moved control at once, without the new address's consent.
- The authentication methods are no longer stored: `getDIDDocument` returns the verification methods in that field,
  so `rotateKey` and `updateDID` change both. In version 1.0.0 the stored authentication methods kept the original
  keys.
- `revokeCredential` refuses an empty credential ID ("DIDRegistry: Invalid credential ID"); the verifier already
  rejected credentials without an ID.
- A revocation entry is stored in one slot (time, reason code, flag); `getRevocationEntry` returns the credential ID
  it was asked about, and an empty entry for a credential that is not revoked. The return types are unchanged. The
  `active` flag shares a storage slot with the controller.
- Gas (osaka). With version 1.0.0's placeholder inputs, `createDID` uses 279,772 gas (346,878 in version 1.0.0) and
  `revokeCredential` 56,042 (171,188 with a 30-character text reason). With realistic documents (one Ed25519 Multikey
  verification method): `createDID` 640,821 for a controller's first DID and 466,991 for its second,
  `revokeCredential` 56,791. The deployment uses 3,069,348 gas for 13,752 bytes of code (version 1.0.0: 2,802,701 on
  Sepolia); the handover functions make the code larger.
- Administrator actions emit events: `AdminAdded`, `AdminRemoved`, `Paused`, `Unpaused`.
- The contract description (NatSpec) states what the registry does and what a pause blocks.
- The DID method name is now `did:smid`.

### Credentials and verification (`src/vc/`)

- `eddsa-jcs-2022` proofs now carry the credential's `@context` (section 3.3.1, step 2, of the cryptosuite
  specification), so proof values agree with the W3C test vector. Credentials signed by version 1.0.0 still verify.
- The verifier checks the proof's type, cryptosuite, purpose and expiry (`proof.expires`), and that the credential's
  `@context` equals the proof's (section 3.3.2 requires only a prefix; entries appended after signing would not be
  signed). The proof value and multikeys are length-checked before base58 decoding, and keys need the multibase `z`.
- Step V1 requires the VC 2.0 base context first and the type `VerifiableCredential`, rejects the VC 1.1 properties
  `issuanceDate` and `expirationDate` instead of ignoring them, and accepts only date-time stamps with a time zone.
- Step V5 requires the verification method to be a `Multikey` controlled by the issuer DID and named under it.
- V1 also requires `issuer` and `credentialSubject.id` to be strings and the dates to be real calendar dates; V4 judges
  the validity period at the moment reported as `checkedAt`; B0 reads the block number with a plain `eth_blockNumber`
  request (ethers' `getBlockNumber()` never goes below the highest number it has seen).
- The issuer signs the credential as JSON will carry it, and canonicalisation refuses values JSON cannot carry
  (undefined, non-finite numbers, lone surrogates).
- Invalid options raise a `TypeError` (`clockToleranceMs` must be a finite number of 0 or more, `blockLag` an integer
  of 0 or more); an invalid caller block number gives `VERIFICATION_ERROR` with `INVALID_BLOCK_TAG`.
- `validFrom` is checked, with a clock tolerance (constructor option `clockToleranceMs`, default 60 s): a credential
  that is not yet valid fails with `CREDENTIAL_NOT_YET_VALID`.
- All contract reads of one verification are pinned to one block, read first (step B0) or given by the caller
  (`blockTag`); option `blockLag` pins below the newest block. The result reports the block as `checkedAtBlock`.
- Step V5 also rejects an issuer DID document that is inactive or carries another DID.
- Optional per-step timing (`timing: true`, durations in `result.timings`).
- A failed request returns `VERIFICATION_ERROR` with an `errorCode`; the result no longer contains the error message,
  which could hold the RPC URL.

### Fixed

- An unparsable `validUntil` was accepted, because the comparison with the current time was false for an invalid
  date. It now fails with `MALFORMED_CREDENTIAL`, as do an unparsable `validFrom` and a `validUntil` earlier than
  `validFrom`.
- The proof configuration was hashed without `@context`, so proof values differed from other `eddsa-jcs-2022`
  implementations.
- After `rotateKey`, the rotated-out key stayed in the authentication methods.
- A correctly signed credential with an empty `id` verified as `VALID`, and one without an `id` failed at the
  revocation check with `VERIFICATION_ERROR`. Revocation is keyed by the credential `id`, so both now fail at V1 with
  `MALFORMED_CREDENTIAL`.
- A VC 1.1 credential, or a signed object without `@context` and `type`, verified as `VALID`, so a VC 1.1
  `expirationDate` was never enforced; a string or NaN `clockToleranceMs` switched the `validFrom` check off;
  timestamps without a time zone were read in the verifier's local zone; a very long proof value took seconds to
  decode (15.9 s for 200,000 characters); impossible dates such as 30 February were rolled over and accepted.
- The latency analysis counted failed Sepolia rows (no time) as 0 ms and paired them, and counted pilot rows; it now
  counts only successful measurements and reports the rest. The mode orders were unbalanced (orders 3 and 4 used 30
  times, 1 and 2 used 20); each is now used 25 times, also when a block is run again in a reserve slot.
- Node's default HTTP agent closes idle sockets after 5 s and reuses the most recent one first, so the concurrent mode
  could time new connections in some mode orders only. `measure-sepolia.js` now keeps sockets open and counts every
  new one per row; the analysis reports such rows by mode and order.
- After an HTTP 429, `measure-sepolia.js` waited for ethers' 30 s request timer before exiting; argument errors were
  reported as `UNKNOWN_ERROR` (now `ARG_LOG_MISSING`, `ARG_BLOCK_LAG`, `ARG_TIMEOUT`). The verifier and the Sepolia
  scripts reported the same JSON-RPC error with different codes, and in most modes every failure was logged as
  `SERVER_ERROR` or `CALL_EXCEPTION`. Both now walk the causes that ethers keeps and log codes such as
  `SERVER_ERROR/HTTP_429` or `CALL_EXCEPTION/SERVER_ERROR/RPC_-32000/BLOCK_UNAVAILABLE` (the last when the node
  reports a missing block); only codes are written, never messages.
- `deploy-sepolia.js --resend` signed the replacement at the current fees, which nodes refuse as underpriced when the
  base fee has not risen; it now pays at least 12.5% more than the transaction it replaces.
- `deploy-sepolia.js` checked for a fixed 0.02 SepoliaETH, less than the setup can cost at the highest base fee it
  accepts; it now requires 28 million gas at the highest fee it may pay (default maximum base fee 0.5 gwei).

### Measurements, scripts and data

- `scripts/measure-gas.js` measures DID documents with real Ed25519 Multikey verification methods and keeps the
  version 1.0.0 placeholder inputs as a second case. It also counts each transaction's storage writes and gives its
  gas under the schedule that Sepolia has used since 6 October 2026 (`scripts/lib/gas-schedule.js`).
- New scripts: `measure-local.js` and `measure-sepolia.js` (verification latency, every sample logged),
  `deploy-sepolia.js` (setup with explicit fees; each step's nonce and hash are saved, so a re-run never sends a
  second transaction for a step; it checks chain, code, DID ownership and the issuer key before writing), `analyze-latency.js` and `scripts/lib/stats.js` (one
  definition per statistic), `check_stats_numpy.py`, `plot-latency.py`.
- Hardhat's hard fork is pinned to osaka. The Hardhat plugins are development dependencies (only `ethers` is needed
  at run time), and `package.json` requires Node.js 20 or later.
- No Hardhat network for Sepolia and no private key in the environment: the Sepolia scripts run with plain Node, read
  only `SEPOLIA_RPC_URL`, and take the deployer key from a file given on the command line. `dotenv` is no longer a
  dependency, and `npm run deploy:sepolia` is gone.
- The latency test in the test suite is a functional check of 100 verifications; timing moved to
  `measure-local.js`.
- `results/did2_sepolia.jsonl` is now `results/sepolia_2026-07-21_n20.jsonl` (content unchanged);
  `results/README.md` replaces `results/sepolia_results.md` and describes every log.
- `analyze-latency.js` also reports the median of each process or block with an order-statistic interval over those
  medians, the medians of
  the first and second halves of each, and headers that disagree; `measure-local.js` runs 100 warm-up verifications
  per process (10 before) and records whether the checkout differs from its commit; `measure-sepolia.js` takes
  `--timeout-ms` and records the commit. `requirements.txt` lists the Python packages.
- Tests: 160 (47 in version 1.0.0), including the W3C `eddsa-jcs-2022` test vector (appendix B.3), leak tests of
  the Sepolia scripts, runs of `deploy-sepolia.js` against a local node (fresh, completed, refused and interrupted
  runs), and a check that the gas figures in the READMEs and this file match the measurement.

## 1.0.0 (24 July 2026)

First archived release (DOI 10.5281/zenodo.21515958), now superseded. Its contract on Sepolia is
`0x5f9017208f3F4A97657E2b32BE433a2641DFEF07`; its measurements are described in `results/README.md`.
