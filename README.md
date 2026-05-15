# DID-Anchored Verifiable Credentials with On-Chain Revocation

Implementation artifact for the paper:  
**"DID-Anchored Verifiable Credentials with On-Chain Revocation for Decentralised Identity Management"**  
Submitted to *IET Blockchain* (Wiley), 2026.

## Overview

This repository contains the Ethereum smart contract, Node.js credential service, and test suite for a W3C-compliant Decentralised Identity (DID) and Verifiable Credential (VC) system with on-chain revocation.

### Key Results
| Operation | Metric |
|---|---|
| `createDID` | 346,878 gas |
| `revokeCredential` | 171,188 gas |
| `verifyCredential` (off-chain, local EVM) | 56.9 ms mean, 79.7 ms p95 |

All 47 test cases pass (30 DIDRegistry + 17 VerifiableCredential).

## Repository Structure

```
contracts/
  DIDRegistry.sol              # Solidity smart contract (DID lifecycle + revocation registry)
src/
  vc/
    vc-service.js              # W3C VC 2.0 issuance — eddsa-jcs-2022, Ed25519 Multikey
    verifier-service.js        # 8-step credential verification pipeline
test/
  DIDRegistry.test.js          # Contract-level tests (30 tests)
  VerifiableCredential.test.js # End-to-end VC flow tests (17 tests)
scripts/
  deploy.js                    # Deployment script
hardhat.config.js              # Hardhat configuration
package.json                   # Node.js dependencies
```

## Prerequisites

- Node.js >= 16
- npm

## Setup

```bash
npm install
```

## Compile

```bash
npm run compile
```

## Test

```bash
npm test
```

Expected output: 47 passing

## Deploy (local node)

```bash
npm run node          # Terminal 1
npm run deploy        # Terminal 2
```

## Standards Implemented

- W3C DID Core 1.0
- W3C Verifiable Credentials Data Model v2.0
- W3C Data Integrity EdDSA Cryptosuites v1.0 (eddsa-jcs-2022)
- W3C Controlled Identifiers v1.0 (Ed25519 Multikey: 0xed01 public, 0x8026 secret)
- JSON Canonicalization Scheme — RFC 8785 (JCS)
- Ed25519 / EdDSA — RFC 8032

## Authors

- Vineeta Rathore — Department of Computer Science and Engineering, Medicaps University, Indore, India
- Manoj Kumar Rawat — Department of Computer Science and Engineering, Medicaps University, Indore, India
