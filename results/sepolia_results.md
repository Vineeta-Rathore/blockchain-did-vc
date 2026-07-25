# Sepolia Public-Network Results (2026-07-21)
Canonical 618-line DIDRegistry (reproduces paper gas exactly), deployed and
measured on the public Sepolia testnet. Raw: did2_sepolia.jsonl.

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

These are the four on-chain reads that the verification pipeline performs.

## On-chain verifiability (for the Data Availability statement)
- Network: Ethereum Sepolia (chainId 11155111)
- DIDRegistry contract: `0x5f9017208f3F4A97657E2b32BE433a2641DFEF07`
- createDID (346,878): tx `0xd48ae9684cda...`
- revokeCredential (171,188): tx `0xe6262ae0f0fb...`
- (full hashes in did2_sepolia.jsonl)
