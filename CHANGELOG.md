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
- `rotateKey` also replaces the old key in the authentication methods, and `updateDID` sets the authentication methods
  to the new verification methods. In version 1.0.0 the authentication methods kept the original keys.
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
  decode (15.9 s for 200,000 characters).

### Measurements, scripts and data

- `scripts/measure-gas.js` measures DID documents with real Ed25519 Multikey verification methods and keeps the
  version 1.0.0 placeholder inputs as a second case. It also counts each transaction's storage writes and gives its
  gas under the schedule that Sepolia has used since 6 October 2026 (`scripts/lib/gas-schedule.js`).
- New scripts: `measure-local.js` and `measure-sepolia.js` (verification latency, every sample logged),
  `deploy-sepolia.js` (setup with explicit fees; each step's nonce and hash are saved, so a re-run never sends a
  second transaction for a step; it checks chain, code, DID ownership and the issuer key before writing), `analyze-latency.js` and `scripts/lib/stats.js` (one
  definition per statistic), `check_stats_numpy.py`, `plot-latency.py`.
- Hardhat's hard fork is pinned to osaka.
- No Hardhat network for Sepolia and no private key in the environment: the Sepolia scripts run with plain Node, read
  only `SEPOLIA_RPC_URL`, and take the deployer key from a file given on the command line. `dotenv` is no longer a
  dependency, and `npm run deploy:sepolia` is gone.
- The latency test in the test suite is a functional check of 100 verifications; timing moved to
  `measure-local.js`.
- `results/did2_sepolia.jsonl` is now `results/sepolia_2026-07-21_n20.jsonl` (content unchanged);
  `results/README.md` replaces `results/sepolia_results.md` and describes every log.
- Tests: 110 (47 in version 1.0.0), including the W3C `eddsa-jcs-2022` test vector (appendix B.3) and leak tests of
  the Sepolia scripts.

## 1.0.0 (24 July 2026)

First archived release (DOI 10.5281/zenodo.21515958), now superseded. Its contract on Sepolia is
`0x5f9017208f3F4A97657E2b32BE433a2641DFEF07`; its measurements are described in `results/README.md`.
