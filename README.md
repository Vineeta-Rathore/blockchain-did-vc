# DID-Anchored Verifiable Credentials with On-Chain Revocation

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21515958.svg)](https://doi.org/10.5281/zenodo.21515958)

Archived release: **https://doi.org/10.5281/zenodo.21515958**

Reference implementation accompanying the paper:

> **Decentralised Identifier-Anchored Verifiable Credentials with On-Chain Revocation for Social Media Identity Management** (2026)

This repository contains the Ethereum smart contract, the Node.js credential
service, and the test suite for a W3C-standards-aligned Decentralised Identifier
(DID) and Verifiable Credential (VC) system with **controller-enforced on-chain
revocation**. It targets the DID and VC layers only; it does not implement
verifiable presentations, holder binding, or zero-knowledge selective disclosure.

## Key results (reproducible)

| Operation | Measured value |
|---|---|
| `createDID` | **346,878 gas** |
| `revokeCredential` | **171,188 gas** |
| End-to-end verification (local Hardhat EVM) | 56.86 ms mean, 79.66 ms p95 (100 runs) |
| End-to-end verification (public Sepolia, four on-chain reads) | 649 ms median; 176 ms when parallelised |
| Test suite | **47 tests pass** (30 `DIDRegistry` + 17 `VerifiableCredential`) |

Gas is deterministic across environments (EVM opcode pricing): the two figures
above are reproduced identically on a local Hardhat EVM and on the public
Ethereum Sepolia testnet. See [`results/sepolia_results.md`](results/sepolia_results.md).

## Repository structure

```
contracts/
  DIDRegistry.sol               # Solidity contract: DID lifecycle + nested revocation registry
src/
  vc/
    vc-service.js               # W3C VC 2.0 issuance: eddsa-jcs-2022, Ed25519 Multikey (0xed01 / 0x8026)
    verifier-service.js         # Eight-step credential verification pipeline
test/
  DIDRegistry.test.js           # Contract-level tests (30)
  VerifiableCredential.test.js  # End-to-end VC flow tests (17)
scripts/
  deploy.js                     # Deployment script (local / Sepolia)
  measure-gas.js                # Reproduces the 346,878 / 171,188 gas figures
results/
  sepolia_results.md            # Public-network measurements (contract address + tx references)
hardhat.config.js               # solc 0.8.19, optimiser 200 runs, chainId 1337
```

## Prerequisites

- Node.js >= 16
- npm

## Quick start

```bash
npm install          # install the ethers v5 / Hardhat toolchain
npm run compile      # compile the contract (solc 0.8.19)
npm test             # run all 47 tests
npm run measure-gas  # print createDID (346,878) and revokeCredential (171,188) gas
```

`npm run measure-gas` deploys the contract on the in-process Hardhat EVM and
prints the two headline gas figures with the exact inputs used in the paper.

## Reproducing the public-network measurements (optional)

On-chain gas is identical on Sepolia; only the network round-trips differ. To
redeploy on Sepolia:

1. Copy `.env.example` to `.env` and set `SEPOLIA_RPC_URL` and a **funded test**
   `PRIVATE_KEY` (Sepolia test ETH only — never a mainnet key).
2. Deploy: `npm run deploy:sepolia`
3. Measure gas on Sepolia: `npx hardhat run scripts/measure-gas.js --network sepolia`

The `.env` file is git-ignored; do not commit private keys.

## On-chain verifiability

The contract used for the paper's public-network results is deployed on Ethereum
Sepolia (chainId 11155111) at:

```
0x5f9017208f3F4A97657E2b32BE433a2641DFEF07
```

The DID-creation (346,878 gas) and revocation (171,188 gas) transactions are
recorded on-chain and viewable on any Sepolia block explorer; references are in
[`results/sepolia_results.md`](results/sepolia_results.md).

## Standards implemented

- W3C Decentralised Identifiers (DID) Core 1.0
- W3C Verifiable Credentials Data Model v2.0
- W3C Data Integrity EdDSA Cryptosuites v1.0 (`eddsa-jcs-2022`)
- W3C Controlled Identifiers v1.0 (Multikey: `0xed01` public / `0x8026` secret, base58btc, `z` multibase)
- RFC 8785 JSON Canonicalization Scheme; RFC 8032 Ed25519

## Citing

If you use this software, please cite the archived release via its Zenodo DOI
(`10.5281/zenodo.21515958`) or the metadata in [`CITATION.cff`](CITATION.cff).
Once the accompanying paper is published, please cite the paper as the primary
reference.

## License

MIT — see [`LICENSE`](LICENSE).
