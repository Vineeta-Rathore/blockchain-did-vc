#!/usr/bin/env node
/**
 * Sepolia setup for version 1.1.0: deploy DIDRegistry, register an issuer DID and a subject DID
 * (did:smid, fresh Ed25519 Multikey keys, the documents of scripts/lib/fixtures.js), sign credentials A and B, and
 * revoke A with reason code 9 (privilegeWithdrawn). Plain Node; the deployer key comes from --key <file> (never from
 * .env, which is read only for SEPOLIA_RPC_URL). Resumable: before each step it reads the chain and skips what is done,
 * so a re-run cannot deploy a second contract.
 *
 *   npx hardhat compile
 *   node scripts/deploy-sepolia.js --key <deployer key file> --env <file with SEPOLIA_RPC_URL>
 *        [--out results/sepolia_v1.1_deployment.json] [--secrets-dir <dir outside any git tree>]
 *        [--tip-gwei 0.01] [--max-base-fee-gwei 1]
 *
 * The issuer's private key is written once to <secrets-dir>/issuer_v1.1.json and never printed; delete it after the
 * deployment gate. The subject's private key is never stored. The record written to --out holds no secret.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');
const R = require('./lib/rpc');
const { VerifiableCredentialService } = require('../src/vc/vc-service');
const { didDocumentInputs, randomCredentialId, randomDidId } = require('./lib/fixtures');

const MIN_BALANCE = ethers.utils.parseEther('0.02');
const REASON_PRIVILEGE_WITHDRAWN = 9;

// Fees are set explicitly. Without overrides, ethers v5 adds a fixed 1.5 gwei priority fee; under the gas schedule
// Sepolia has used since 6 Oct 2026 the setup uses about 28 million gas, which at that tip would cost about
// 0.04 SepoliaETH. Default: a 0.01 gwei tip and maxFeePerGas = 2 x the latest base fee + tip. The script stops,
// before sending, if the base fee is above --max-base-fee-gwei (default 1), so that a fee spike cannot drain the key.
function feePolicy() {
  const tip = ethers.utils.parseUnits(arg('--tip-gwei', '0.01'), 'gwei');
  const maxBase = ethers.utils.parseUnits(arg('--max-base-fee-gwei', '1'), 'gwei');
  return {
    describe: { tipGwei: ethers.utils.formatUnits(tip, 'gwei'), maxBaseFeeGwei: ethers.utils.formatUnits(maxBase, 'gwei'),
      maxFeePerGas: '2 x latest base fee + tip' },
    overrides: async (provider) => {
      const block = await provider.getBlock('latest');
      const base = block.baseFeePerGas || ethers.constants.Zero;
      if (base.gt(maxBase)) throw Object.assign(new Error('fee'), { code: 'BASE_FEE_TOO_HIGH' });
      return { type: 2, maxPriorityFeePerGas: tip, maxFeePerGas: base.mul(2).add(tip) };
    },
  };
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const url = R.readRpcUrl(arg('--env'));
  const keyFile = arg('--key');
  const outPath = arg('--out', 'results/sepolia_v1.1_deployment.json');
  const secretsDir = arg('--secrets-dir', path.join(os.homedir(), '.r2_secrets'));
  if (!url) throw Object.assign(new Error('missing'), { code: 'SEPOLIA_RPC_URL_MISSING' });
  if (!keyFile) throw Object.assign(new Error('missing'), { code: 'KEY_FILE_MISSING' });

  const deployerKey = JSON.parse(fs.readFileSync(keyFile, 'utf8')).privateKey;
  const redact = R.makeRedactor(url, [deployerKey, deployerKey && deployerKey.replace(/^0x/, '')]);
  R.installGuards(redact);
  const say = R.makeWriter(redact, (t) => process.stdout.write(`${t}\n`));

  // --expect-chain exists only for dry runs against a local node; the default is Sepolia.
  const expectedChain = Number(arg('--expect-chain', String(R.SEPOLIA.chainId)));
  const provider = R.makeProvider(url, { network: { name: expectedChain === R.SEPOLIA.chainId ? 'sepolia' : 'local', chainId: expectedChain } });
  const chainId = ethers.BigNumber.from(await provider.send('eth_chainId', [])).toNumber();
  if (chainId !== expectedChain) throw Object.assign(new Error('chain'), { code: 'WRONG_CHAIN' });
  const wallet = new ethers.Wallet(deployerKey, provider);
  const fees = feePolicy();
  const balance = await wallet.getBalance();
  say(`deployer ${wallet.address}, balance ${ethers.utils.formatEther(balance)} SepoliaETH`);

  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'DIDRegistry.sol', 'DIDRegistry.json'), 'utf8'));
  const state = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : { network: 'sepolia', chainId, deployer: wallet.address, txs: {} };
  if (state.deployer !== wallet.address) throw Object.assign(new Error('deployer'), { code: 'DEPLOYER_MISMATCH' });
  state.feePolicy = fees.describe;
  const save = () => {
    const text = `${JSON.stringify(state, null, 2)}\n`;
    const hits = R.scanText(text, [deployerKey, ...R.secretParts(url)]);
    if (hits.length) throw Object.assign(new Error('scan'), { code: 'SELF_SCAN_FAILED' });
    fs.writeFileSync(outPath, text);
  };
  const record = async (name, tx) => {
    const receipt = await tx.wait(1);
    state.txs[name] = { hash: receipt.transactionHash, block: receipt.blockNumber, gasUsed: receipt.gasUsed.toNumber(),
      effectiveGasPrice: receipt.effectiveGasPrice ? receipt.effectiveGasPrice.toString() : null, status: receipt.status };
    save();
    say(`${name}: block ${receipt.blockNumber}, gas ${receipt.gasUsed.toString()}`);
    return receipt;
  };

  // 1. Deploy (skipped if the recorded address already holds code)
  const hasCode = state.address && (await provider.getCode(state.address)) !== '0x';
  if (!hasCode) {
    if (balance.lt(MIN_BALANCE)) throw Object.assign(new Error('balance'), { code: 'BALANCE_TOO_LOW' });
    const contract = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet).deploy(await fees.overrides(provider));
    state.address = contract.address;
    save();
    await record('deploy', contract.deployTransaction);
  } else {
    say(`deploy: done earlier (${state.address})`);
  }
  const onchain = await provider.getCode(state.address);
  state.bytecode = {
    runtimeKeccak: ethers.utils.keccak256(onchain),
    artifactDeployedKeccak: ethers.utils.keccak256(artifact.deployedBytecode),
    equal: onchain.toLowerCase() === artifact.deployedBytecode.toLowerCase(),
  };
  save();
  const registry = new ethers.Contract(state.address, artifact.abi, wallet);

  // 2. Keys and inputs (chosen once; the issuer's private key is stored outside every git tree)
  fs.mkdirSync(secretsDir, { recursive: true });
  const issuerKeyFile = path.join(secretsDir, 'issuer_v1.1.json');
  if (!fs.existsSync(issuerKeyFile)) {
    const k = VerifiableCredentialService.generateEd25519KeyPair();
    fs.writeFileSync(issuerKeyFile, JSON.stringify({ purpose: 'v1.1.0 Sepolia issuer; delete after the deployment gate',
      publicKeyMultibase: k.publicKeyMultibase, secretKeyMultibase: k.secretKeyMultibase, created: new Date().toISOString() }), { flag: 'wx' });
  }
  const issuerKey = JSON.parse(fs.readFileSync(issuerKeyFile, 'utf8'));
  if (!state.inputs) {
    const subjectPublic = VerifiableCredentialService.generateEd25519KeyPair().publicKeyMultibase; // secret discarded
    state.inputs = {
      issuer: didDocumentInputs({ didId: randomDidId(), publicKeyMultibase: issuerKey.publicKeyMultibase, withService: true }),
      subject: didDocumentInputs({ didId: randomDidId(), publicKeyMultibase: subjectPublic, withService: false }),
      credentialId: randomCredentialId(),
      reasonCode: REASON_PRIVILEGE_WITHDRAWN,
    };
    save();
  }
  const { issuer, subject } = state.inputs;

  // 3. Register the issuer DID (first DID of the deployer) and the subject DID (second)
  for (const [name, doc] of [['createIssuerDID', issuer], ['createSubjectDID', subject]]) {
    if (await registry.verifyDID(doc.didId)) {
      say(`${name}: done earlier`);
    } else {
      await record(name, await registry.createDID(doc.didId, doc.verificationMethods, doc.services, doc.dataHash,
        await fees.overrides(provider)));
    }
  }

  // 4. Sign credentials A (to be revoked) and B (stays valid)
  if (!state.credentials) {
    const sign = (credentialId) => VerifiableCredentialService.issueCredential({
      issuerDid: issuer.didId,
      subjectDid: subject.didId,
      privateKeyMultibase: issuerKey.secretKeyMultibase,
      verificationMethod: JSON.parse(issuer.verificationMethods[0]),
      registryAddress: state.address,
      claims: { name: 'Verified Identity', role: 'verified-account' },
      credentialId,
    });
    state.credentials = { A: sign(state.inputs.credentialId), B: sign(randomCredentialId()) };
    save();
  }

  // 5. Revoke A with reason code 9
  if (await registry.isCredentialRevoked(issuer.didId, state.credentials.A.id)) {
    say('revokeCredentialA: done earlier');
  } else {
    await record('revokeCredentialA', await registry.revokeCredential(issuer.didId, state.credentials.A.id, state.inputs.reasonCode,
      await fees.overrides(provider)));
  }

  state.deployerNonceAfterSetup = await provider.getTransactionCount(wallet.address, 'latest');
  state.completedAt = new Date().toISOString();
  save();
  say(`setup complete; deployer nonce ${state.deployerNonceAfterSetup}; bytecode equal to artifact: ${state.bytecode.equal}`);
  say('self-scan: pass');
}

main().catch((error) => {
  process.stderr.write(`deploy-sepolia failed: ${R.errorCode(error)}\n`);
  process.exit(1);
});
