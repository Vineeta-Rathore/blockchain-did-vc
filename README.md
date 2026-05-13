# DID-Anchored Verifiable Credentials with On-Chain Revocation

Implementation artifact for the paper:  
**"DID-Anchored Verifiable Credentials with On-Chain Revocation for Decentralised Identity Management"**  
Submitted to *IET Blockchain* (Wiley), 2026.

## Overview

This repository contains the Ethereum smart contract, test suite, and deployment scripts for a W3C-compliant Decentralised Identity (DID) and Verifiable Credential (VC) system with on-chain revocation.

### Key Results
| Operation | Gas Cost |
|---|---|
| `createDID` | 346,878 gas |
| `revokeCredential` | 171,188 gas |
| `verifyCredential` (off-chain) | 44.5 ms |

All 46 test cases pass.

## Repository Structure

```
contracts/
  DIDRegistry.sol        # Solidity smart contract (DID + VC revocation registry)
test/
  DIDRegistry.test.js    # Hardhat/Mocha test suite (46 tests)
scripts/
  deploy.js              # Deployment script
hardhat.config.js        # Hardhat configuration
package.json             # Node.js dependencies
benchmark_results.json   # Gas benchmarks
integration_results.json # Integration test results
network-info.json        # Sepolia testnet deployment info
production_deployment.json # Production deployment metadata
security_audit_report.json # Security audit findings
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

## Deploy (local node)

```bash
npm run node          # Terminal 1
npm run deploy        # Terminal 2
```

## Standards

- W3C DID Core 1.0
- W3C Verifiable Credentials Data Model v2.0
- W3C Data Integrity EdDSA Cryptosuites (eddsa-jcs-2022)
- W3C Bitstring Status List v1.0
- Ed25519 / EdDSA (RFC 8032)

## Authors

- Vineeta Rathore — Department of Computer Science and Engineering, Medicaps University, Indore, India
- Manoj Kumar Rawat — Department of Computer Science and Engineering, Medicaps University, Indore, India
