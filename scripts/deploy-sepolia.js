#!/usr/bin/env node
/**
 * Sepolia setup for version 1.1.0: deploy DIDRegistry, register an issuer DID and a subject DID
 * (did:smid, fresh Ed25519 Multikey keys, the documents of scripts/lib/fixtures.js), sign credentials A and B, and
 * revoke A with reason code 9 (privilegeWithdrawn). Plain Node; the deployer key comes from --key <file> (never from
 * .env, which is read only for SEPOLIA_RPC_URL).
 *
 * Resumable without repeating a transaction. Each step's nonce is saved in the record before the transaction is sent,
 * and its hash right after. A re-run waits for that transaction, or sends the step again with the same nonce, which
 * the chain can accept only once; it never sends a second transaction for a step under a new nonce. Before any write,
 * a re-run also checks that the record belongs to this chain and deployer, that the contract's code equals the
 * compiled artifact, that both DIDs are controlled by the deployer with the recorded documents, and that the issuer
 * key matches the recorded inputs.
 *
 *   npx hardhat compile
 *   node scripts/deploy-sepolia.js --key <deployer key file> --env <file with SEPOLIA_RPC_URL>
 *        [--out results/sepolia_v1.1_deployment.json] [--secrets-dir <dir outside any git tree>]
 *        [--tip-gwei 0.01] [--max-base-fee-gwei 1] [--wait-timeout-s 600] [--resend]
 *
 * --resend sends a step that is still pending again, with the same nonce and the current fees (to replace a stuck
 * transaction). The issuer's private key is written once to <secrets-dir>/issuer_v1.1.json and never printed; it is
 * needed only until the credentials are signed, and is deleted after the deployment gate. The subject's private key
 * is never stored. The record written to --out holds no secret. The key file and the secrets directory must lie
 * outside every git working tree. --expect-chain accepts only Sepolia (the default) and local Hardhat chains.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ethers } = require('ethers');
const R = require('./lib/rpc');
const { VerifiableCredentialService } = require('../src/vc/vc-service');
const { didDocumentInputs, randomCredentialId, randomDidId } = require('./lib/fixtures');

const MIN_BALANCE = ethers.utils.parseEther('0.02');
const REASON_PRIVILEGE_WITHDRAWN = 9;
const ALLOWED_CHAINS = new Set([R.SEPOLIA.chainId, 1337, 31337]);

const fail = (code) => Object.assign(new Error(code), { code });

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(name);

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
      if (base.gt(maxBase)) throw fail('BASE_FEE_TOO_HIGH');
      return { type: 2, maxPriorityFeePerGas: tip, maxFeePerGas: base.mul(2).add(tip) };
    },
  };
}

// True if dir, or its nearest existing parent, lies inside a git working tree (ignored folders included).
function insideGitWorkTree(dir) {
  let d = path.resolve(dir);
  while (!fs.existsSync(d)) {
    const parent = path.dirname(d);
    if (parent === d) return false;
    d = parent;
  }
  try {
    return execFileSync('git', ['-C', d, 'rev-parse', '--is-inside-work-tree'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true';
  } catch {
    return false;
  }
}

async function main() {
  const url = R.readRpcUrl(arg('--env'));
  const keyFile = arg('--key');
  const outPath = arg('--out', 'results/sepolia_v1.1_deployment.json');
  const secretsDir = arg('--secrets-dir', path.join(os.homedir(), '.blockchain-did-vc-secrets'));
  const waitTimeoutMs = Number(arg('--wait-timeout-s', '600')) * 1000;
  if (!url) throw fail('SEPOLIA_RPC_URL_MISSING');
  if (!keyFile) throw fail('KEY_FILE_MISSING');
  const expectedChain = Number(arg('--expect-chain', String(R.SEPOLIA.chainId)));
  if (!ALLOWED_CHAINS.has(expectedChain)) throw fail('CHAIN_NOT_ALLOWED');
  if (insideGitWorkTree(path.dirname(path.resolve(keyFile))) || insideGitWorkTree(secretsDir)) {
    throw fail('SECRETS_IN_GIT_TREE');
  }

  const deployerKey = JSON.parse(fs.readFileSync(keyFile, 'utf8')).privateKey;
  const redact = R.makeRedactor(url, [deployerKey, deployerKey && deployerKey.replace(/^0x/, '')]);
  R.installGuards(redact);
  const say = R.makeWriter(redact, (t) => process.stdout.write(`${t}\n`));

  const networkName = expectedChain === R.SEPOLIA.chainId ? 'sepolia' : 'local';
  const provider = R.makeProvider(url, { network: { name: networkName, chainId: expectedChain } });
  const chainId = ethers.BigNumber.from(await provider.send('eth_chainId', [])).toNumber();
  if (chainId !== expectedChain) throw fail('WRONG_CHAIN');
  const wallet = new ethers.Wallet(deployerKey, provider);
  const fees = feePolicy();
  const balance = await wallet.getBalance();
  say(`deployer ${wallet.address}, balance ${ethers.utils.formatEther(balance)} ETH, chain ${chainId}`);

  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'DIDRegistry.sol', 'DIDRegistry.json'), 'utf8'));
  const state = fs.existsSync(outPath)
    ? JSON.parse(fs.readFileSync(outPath, 'utf8'))
    : { network: networkName, chainId, deployer: wallet.address, txs: {}, pending: {} };
  if (state.deployer !== wallet.address) throw fail('DEPLOYER_MISMATCH');
  if (state.chainId !== chainId) throw fail('CHAIN_MISMATCH');
  state.txs = state.txs || {};
  state.pending = state.pending || {};
  state.feePolicy = fees.describe;
  const save = () => {
    const text = `${JSON.stringify(state, null, 2)}\n`;
    const hits = R.scanText(text, [deployerKey, ...R.secretParts(url)]);
    if (hits.length) throw fail('SELF_SCAN_FAILED');
    fs.writeFileSync(outPath, text);
  };

  const finish = async (name, receipt, isDone) => {
    if (!receipt) throw fail('TX_NOT_MINED');
    if (receipt.status !== 1) throw fail('TX_FAILED');
    state.txs[name] = { hash: receipt.transactionHash, nonce: state.pending[name].nonce, block: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toNumber(), effectiveGasPrice: receipt.effectiveGasPrice ? receipt.effectiveGasPrice.toString() : null,
      status: receipt.status };
    delete state.pending[name];
    save();
    say(`${name}: block ${receipt.blockNumber}, gas ${receipt.gasUsed.toString()}`);
    if (!(await isDone())) throw fail('STEP_NOT_DONE_AFTER_TX');
  };

  // One transaction per step (see the header). isDone() reads the chain and throws on a state this script did not make.
  const step = async (name, isDone, send, beforeSend = () => {}) => {
    if (state.txs[name]) {
      if (!(await isDone())) throw fail('RECORD_AND_CHAIN_DISAGREE');
      say(`${name}: done earlier`);
      return;
    }
    let pending = state.pending[name];
    if (pending && pending.hash && !flag('--resend')) {
      try {
        await finish(name, await provider.waitForTransaction(pending.hash, 1, waitTimeoutMs), isDone);
        return;
      } catch (error) {
        if (error.code === 'TIMEOUT') throw fail('TX_PENDING_TIMEOUT');
        throw error;
      }
    }
    if (pending && !pending.hash) {
      // The nonce was saved but the hash was not (the run stopped while sending): has that nonce been used?
      const latest = await provider.getTransactionCount(wallet.address, 'latest');
      if (latest > pending.nonce) {
        if (!(await isDone())) throw fail('NONCE_USED_ELSEWHERE');
        state.txs[name] = { hash: null, nonce: pending.nonce, note: 'hash not recorded; the chain shows the step done' };
        delete state.pending[name];
        save();
        say(`${name}: done (nonce ${pending.nonce}; hash not recorded)`);
        return;
      }
    }
    if (!pending) {
      pending = { nonce: await provider.getTransactionCount(wallet.address, 'pending') };
      state.pending[name] = pending;
      beforeSend(pending);
      save();
    }
    const tx = await send({ ...(await fees.overrides(provider)), nonce: pending.nonce });
    pending.hash = tx.hash;
    save();
    say(`${name}: sent ${tx.hash}, nonce ${pending.nonce}`);
    try {
      await finish(name, await provider.waitForTransaction(tx.hash, 1, waitTimeoutMs), isDone);
    } catch (error) {
      if (error.code === 'TIMEOUT') throw fail('TX_PENDING_TIMEOUT');
      throw error;
    }
  };

  // 1. Deploy. The address follows from the deployer and the saved nonce, so it is known before sending.
  const codeMatches = async () => {
    if (!state.address) return false;
    const code = await provider.getCode(state.address);
    if (code === '0x') return false;
    if (code.toLowerCase() !== artifact.deployedBytecode.toLowerCase()) throw fail('BYTECODE_MISMATCH');
    return true;
  };
  if (!state.txs.deploy && !state.pending.deploy && balance.lt(MIN_BALANCE)) throw fail('BALANCE_TOO_LOW');
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  await step('deploy', codeMatches,
    (overrides) => wallet.sendTransaction(factory.getDeployTransaction(overrides)),
    (pending) => { state.address = ethers.utils.getContractAddress({ from: wallet.address, nonce: pending.nonce }); });
  const onchain = await provider.getCode(state.address);
  state.bytecode = {
    runtimeKeccak: ethers.utils.keccak256(onchain),
    artifactDeployedKeccak: ethers.utils.keccak256(artifact.deployedBytecode),
    equal: onchain.toLowerCase() === artifact.deployedBytecode.toLowerCase(),
  };
  save();
  if (!state.bytecode.equal) throw fail('BYTECODE_MISMATCH');
  const registry = new ethers.Contract(state.address, artifact.abi, wallet);

  // 2. Keys and inputs (chosen once). The issuer's private key is needed until the credentials are signed.
  let issuerKey = null;
  if (!state.inputs || !state.credentials) {
    fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    const issuerKeyFile = path.join(secretsDir, 'issuer_v1.1.json');
    if (!fs.existsSync(issuerKeyFile)) {
      if (state.inputs) throw fail('ISSUER_KEY_MISSING');
      const k = VerifiableCredentialService.generateEd25519KeyPair();
      fs.writeFileSync(issuerKeyFile, JSON.stringify({ purpose: 'v1.1.0 Sepolia issuer; delete after the deployment gate',
        publicKeyMultibase: k.publicKeyMultibase, secretKeyMultibase: k.secretKeyMultibase, created: new Date().toISOString() }),
      { flag: 'wx', mode: 0o600 });
    }
    issuerKey = JSON.parse(fs.readFileSync(issuerKeyFile, 'utf8'));
  }
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
  if (issuerKey && JSON.parse(issuer.verificationMethods[0]).publicKeyMultibase !== issuerKey.publicKeyMultibase) {
    throw fail('ISSUER_KEY_MISMATCH');
  }

  // 3. Register the issuer DID (first DID of the deployer) and the subject DID (second)
  for (const [name, doc] of [['createIssuerDID', issuer], ['createSubjectDID', subject]]) {
    const isDone = async () => {
      const controller = await registry.getController(doc.didId);
      if (controller === ethers.constants.AddressZero) return false;
      if (controller !== wallet.address) throw fail('DID_TAKEN');
      const stored = await registry.getDIDDocument(doc.didId);
      if (stored.dataHash !== doc.dataHash || stored.verificationMethods[0] !== doc.verificationMethods[0]) {
        throw fail('DID_DOCUMENT_MISMATCH');
      }
      return true;
    };
    await step(name, isDone,
      (overrides) => registry.createDID(doc.didId, doc.verificationMethods, doc.services, doc.dataHash, overrides));
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
  await step('revokeCredentialA', () => registry.isCredentialRevoked(issuer.didId, state.credentials.A.id),
    (overrides) => registry.revokeCredential(issuer.didId, state.credentials.A.id, state.inputs.reasonCode, overrides));

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
