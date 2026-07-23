# Paper 2 — Sepolia Public-Network Results (2026-07-21)
Canonical 618-line DIDRegistry (reproduces paper gas exactly), deployed and
measured on the public Sepolia testnet. Answers Reviewer 2 (R2.3 local-only /
"56.86 ms misleading"; R2.4 call count). Raw: impl/build/did2_sepolia.jsonl.

## Gas determinism — Sepolia == paper's local numbers (exact)
| Operation (canonical inputs) | Local (paper) | Sepolia | diff |
|---|---|---|---|
| createDID | 346,878 | **346,878** | 0 |
| revokeCredential | 171,188 | **171,188** | 0 |
| Contract deployment | — | 2,802,701 | — |

Creation gas varies with DID-document content and is 346,878 for a
controller's first DID (cold controller-index slot) and ~329,766 for
subsequent DIDs (warm) — an honest nuance; the paper's headline is the
first-creation cost, reproduced exactly on-chain. Gas is thus deterministic
across local Hardhat and public Sepolia, as expected for EVM opcode pricing.

## Verification latency — the FOUR on-chain reads (valid path), n=20
| Quantity | Value |
|---|---|
| 4-read total, median | **649 ms** |
| 4-read total, p95 | 802 ms |
| 4-read total, 95% bootstrap CI | **[635, 702] ms** (5,000 resamples) |
| verifyDID (issuer) | 161 ms median |
| verifyDID (subject) | 158 ms median |
| getDIDDocument (issuer) | 163 ms median |
| isCredentialRevoked | 163 ms median |
| vs. local Hardhat (56.86 ms) | **11.4x slower** |

This replaces the misleading local headline with the realistic public-network
figure, and confirms the pipeline performs **four** on-chain reads (not three)
— fixing the Section 4.4 vs 6.3 inconsistency R2 flagged.

## On-chain verifiability (for the Data Availability statement)
- Network: Ethereum Sepolia (chainId 11155111)
- DIDRegistry contract: `0x5f9017208f3F4A97657E2b32BE433a2641DFEF07`
- createDID (346,878): tx `0xd48ae9684cda...`
- revokeCredential (171,188): tx `0xe6262ae0f0fb...`
- (full hashes in impl/build/did2_sepolia.jsonl)

## CRITICAL action for the reproducible-code artifact (R2.1 last column)
The public repo github.com/Vineeta-Rathore/blockchain-did-vc currently commits
an OUTDATED 90-line DIDRegistry.sol that lacks revokeCredential/isCredentialRevoked
— inconsistent with its own tests/services, so `npm test` would FAIL for a
reviewer. The canonical 618-line contract (this one, reproducing 346,878/171,188)
MUST be pushed to the repo before it is cited as the reproducible artifact.
