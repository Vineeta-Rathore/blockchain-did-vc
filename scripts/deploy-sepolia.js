#!/usr/bin/env node
/**
 * Sepolia setup for version 1.1.0: deploy DIDRegistry, register an issuer DID and a subject DID
 * (did:smid, fresh Ed25519 Multikey keys, the documents of scripts/lib/fixtures.js), sign credentials A and B, and
 * revoke A with reason code 9 (privilegeWithdrawn). Plain Node; the deployer key comes from --key <file> (never from
 * .env, which is read only for SEPOLIA_RPC_URL).
 *
 * Resumable without repeating a transaction. Each step's nonce is saved in the record first; each transaction is then
 * signed, and its hash and raw form are saved before it is broadcast. A re-run looks for a receipt of any transaction
 * sent for the step, broadcasts the saved one again if none is mined, and never sends a second transaction for a step
 * under a new nonce (a failed transaction, status 0, is recorded and its step starts again). One run at a time
 * (a lock file next to the record); a completed record is left untouched. Before any write,
 * a re-run also checks that the record belongs to this chain and deployer, that the contract's code equals the
 * compiled artifact, that both DIDs are controlled by the deployer with the recorded documents, and that the issuer
 * key matches the recorded inputs.
 *
 *   npx hardhat compile
 *   node scripts/deploy-sepolia.js --key <deployer key file> --env <file with SEPOLIA_RPC_URL>
 *        [--out results/sepolia_v1.1_deployment.json] [--secrets-dir <dir outside any git tree>]
 *        [--tip-gwei 0.01] [--max-base-fee-gwei 0.5] [--wait-timeout-s 600] [--resend]
 *
 * --resend signs a pending step again with the same nonce (to replace a stuck transaction), at the current fees or
 * 12.5% above the last signed transaction's, whichever is higher, but never above 2 x the maximum base fee + tip
 * (FEE_CAP_REACHED); whichever transaction is mined is recorded, with its own fees. A step whose nonce was saved but
 * whose transaction was never signed (the run stopped before, for example on BASE_FEE_TOO_HIGH) is signed on a plain
 * re-run. The issuer's private key is written once to <secrets-dir>/issuer_v1.1.json and never printed; it is
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
const { arg, flag } = require('./lib/cli');
const { VerifiableCredentialService } = require('../src/vc/vc-service');
const { didDocumentInputs, randomCredentialId, randomDidId } = require('./lib/fixtures');

// Gas of the four setup transactions under Sepolia's schedule (deployment 21.69 M, createDID 3.01 M and 2.14 M,
// revokeCredential 0.14 M, together 26.98 M; results/README.md), rounded up.
const GAS_BUDGET = 28000000;
const REASON_PRIVILEGE_WITHDRAWN = 9;
const ALLOWED_CHAINS = new Set([R.SEPOLIA.chainId, 1337, 31337]);

const fail = (code) => Object.assign(new Error(code), { code });


// Fees are set explicitly. Without overrides, ethers v5 adds a fixed 1.5 gwei priority fee; under the gas schedule
// Sepolia has used since 6 Oct 2026 the setup uses about 27 million gas, which at that tip would cost about
// 0.04 SepoliaETH. Default: a 0.01 gwei tip and maxFeePerGas = 2 x the latest base fee + tip. The script stops,
// before sending, if the base fee is above --max-base-fee-gwei (default 0.5), so that a fee spike cannot drain the
// key. A fresh run needs a balance of GAS_BUDGET x (2 x the maximum base fee + tip), so that it cannot stop partway
// for want of funds while the base fee stays below the maximum (0.0283 SepoliaETH with the defaults).
const GWEI = /^\d+(\.\d{1,9})?$/;

function feePolicy() {
  const tipText = arg('--tip-gwei', '0.01');
  const maxBaseText = arg('--max-base-fee-gwei', '0.5');
  if (!GWEI.test(tipText)) throw fail('ARG_TIP');
  if (!GWEI.test(maxBaseText) || Number(maxBaseText) <= 0) throw fail('ARG_MAX_BASE_FEE');
  const tip = ethers.utils.parseUnits(tipText, 'gwei');
  const maxBase = ethers.utils.parseUnits(maxBaseText, 'gwei');
  return {
    minBalance: maxBase.mul(2).add(tip).mul(GAS_BUDGET),
    // The highest maxFeePerGas the policy allows, also for replacements.
    ceiling: maxBase.mul(2).add(tip),
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
  const waitText = arg('--wait-timeout-s', '600');
  if (!/^[1-9]\d{0,5}$/.test(waitText || '')) throw fail('ARG_WAIT_TIMEOUT');
  const waitTimeoutMs = Number(waitText) * 1000;
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

  // One run at a time for a record. A run that is killed leaves the lock file, which is then removed by hand.
  const lockPath = `${outPath}.lock`;
  let lockFd;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
  } catch {
    throw fail('RECORD_LOCKED');
  }
  process.on('exit', () => {
    try {
      fs.closeSync(lockFd);
      fs.unlinkSync(lockPath);
    } catch {
      // nothing to clean
    }
  });

  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'DIDRegistry.sol', 'DIDRegistry.json'), 'utf8'));
  const state = fs.existsSync(outPath)
    ? JSON.parse(fs.readFileSync(outPath, 'utf8'))
    : { network: networkName, chainId, deployer: wallet.address, txs: {}, pending: {} };
  if (state.deployer !== wallet.address) throw fail('DEPLOYER_MISMATCH');
  if (state.chainId !== chainId) throw fail('CHAIN_MISMATCH');
  state.txs = state.txs || {};
  state.pending = state.pending || {};
  if (state.completedAt) {
    say(`setup already complete (${state.completedAt}); the record is left as it is`);
    return;
  }
  state.feePolicy = fees.describe;
  const save = () => {
    const text = `${JSON.stringify(state, null, 2)}\n`;
    const hits = R.scanText(text, [deployerKey, ...R.secretParts(url)]);
    if (hits.length) throw fail('SELF_SCAN_FAILED');
    fs.writeFileSync(outPath, text);
  };

  const sleep = (t) => new Promise((resolve) => setTimeout(resolve, t));
  const minedReceipt = async (pending) => {
    for (const hash of pending.hashes) {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt && receipt.blockNumber !== null && receipt.blockNumber !== undefined) return receipt;
    }
    return null;
  };

  const finish = async (name, receipt, isDone) => {
    const pending = state.pending[name];
    const entry = { hash: receipt.transactionHash, nonce: pending.nonce, block: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toNumber(), effectiveGasPrice: receipt.effectiveGasPrice ? receipt.effectiveGasPrice.toString() : null,
      status: receipt.status, fees: (pending.feesByHash || {})[receipt.transactionHash] || pending.fees };
    delete state.pending[name];
    if (receipt.status !== 1) {
      // A failed transaction used its nonce; the step starts again with a new one on the next run.
      state.failed = [...(state.failed || []), { step: name, ...entry }];
      save();
      throw fail('TX_FAILED');
    }
    state.txs[name] = entry;
    save();
    say(`${name}: block ${receipt.blockNumber}, gas ${receipt.gasUsed.toString()}`);
    if (!(await isDone())) throw fail('STEP_NOT_DONE_AFTER_TX');
  };

  // Waits until one of the step's transactions is mined (any of them: a replacement or the original).
  const waitAny = async (name, isDone) => {
    const deadline = Date.now() + waitTimeoutMs;
    for (;;) {
      const receipt = await minedReceipt(state.pending[name]);
      if (receipt) return finish(name, receipt, isDone);
      if (Date.now() > deadline) throw fail('TX_PENDING_TIMEOUT');
      await sleep(3000);
    }
  };

  // Broadcasting a transaction the node already has is harmless; errors on a re-broadcast are not fatal, because the
  // step is then decided by its receipts and the nonce.
  const broadcast = async (signed, rebroadcast) => {
    try {
      await provider.sendTransaction(signed);
    } catch (error) {
      if (!rebroadcast) throw error;
    }
  };

  // One transaction per step (see the header). Each transaction is signed first, and its hash and raw form are saved
  // before it is broadcast, so no transaction of a step can go unrecorded. isDone() reads the chain and throws on a
  // state this script did not make.
  const step = async (name, isDone, buildTx, beforeSend = () => {}) => {
    if (state.txs[name]) {
      if (!(await isDone())) throw fail('RECORD_AND_CHAIN_DISAGREE');
      say(`${name}: done earlier`);
      return;
    }
    let pending = state.pending[name];
    if (pending) {
      const receipt = await minedReceipt(pending);
      if (receipt) return finish(name, receipt, isDone);
      const latest = await provider.getTransactionCount(wallet.address, 'latest');
      if (latest > pending.nonce) {
        // The nonce is used; give the node a moment (up to 30 s, or the wait timeout if shorter) to show the receipt
        // of one of our transactions.
        for (let i = 0; i < 10; i++) {
          await sleep(Math.min(30000, waitTimeoutMs) / 10);
          const late = await minedReceipt(pending);
          if (late) return finish(name, late, isDone);
        }
        throw fail('NONCE_USED_ELSEWHERE');
      }
      // A step with a saved nonce but no signed transaction (the run stopped before signing) is signed below.
      if (!flag('--resend') && pending.hashes.length) {
        await broadcast(pending.raw[pending.raw.length - 1], true);
        say(`${name}: waiting for ${pending.hashes[pending.hashes.length - 1]}, nonce ${pending.nonce}`);
        return waitAny(name, isDone);
      }
    }
    if (!pending) {
      pending = { nonce: await provider.getTransactionCount(wallet.address, 'pending'), hashes: [], raw: [] };
      state.pending[name] = pending;
      beforeSend(pending);
      save();
    }
    // A replacement (--resend) must pay at least 10% more than the transaction it replaces, in both fee fields, or nodes
    // refuse it as underpriced; it pays the current policy or 12.5% more than the last signed one, whichever is higher.
    const overrides = await fees.overrides(provider);
    if (pending.fees) {
      const bumped = (v) => ethers.BigNumber.from(v).mul(1125).div(1000).add(1);
      const max = (a, b) => (a.gt(b) ? a : b);
      overrides.maxFeePerGas = max(overrides.maxFeePerGas, bumped(pending.fees.maxFeePerGas));
      overrides.maxPriorityFeePerGas = max(overrides.maxPriorityFeePerGas, bumped(pending.fees.maxPriorityFeePerGas));
      if (overrides.maxFeePerGas.gt(fees.ceiling)) throw fail('FEE_CAP_REACHED');
    }
    const request = await wallet.populateTransaction(await buildTx({ ...overrides, nonce: pending.nonce }));
    const signed = await wallet.signTransaction(request);
    const hash = ethers.utils.keccak256(signed);
    pending.hashes.push(hash);
    pending.raw.push(signed);
    pending.fees = { maxPriorityFeePerGas: request.maxPriorityFeePerGas.toString(), maxFeePerGas: request.maxFeePerGas.toString(),
      gasLimit: request.gasLimit.toString() };
    pending.feesByHash = { ...(pending.feesByHash || {}), [hash]: pending.fees };
    save();
    await broadcast(signed, false);
    say(`${name}: sent ${hash}, nonce ${pending.nonce}`);
    return waitAny(name, isDone);
  };

  // 1. Deploy. The address follows from the deployer and the saved nonce, so it is known before sending.
  const codeMatches = async () => {
    if (!state.address) return false;
    const code = await provider.getCode(state.address);
    if (code === '0x') return false;
    if (code.toLowerCase() !== artifact.deployedBytecode.toLowerCase()) throw fail('BYTECODE_MISMATCH');
    return true;
  };
  if (!state.txs.deploy && !state.pending.deploy && balance.lt(fees.minBalance)) throw fail('BALANCE_TOO_LOW');
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  await step('deploy', codeMatches,
    (overrides) => factory.getDeployTransaction(overrides),
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
      (overrides) => registry.populateTransaction.createDID(doc.didId, doc.verificationMethods, doc.services, doc.dataHash, overrides));
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
    (overrides) => registry.populateTransaction.revokeCredential(issuer.didId, state.credentials.A.id, state.inputs.reasonCode, overrides));

  state.deployerNonceAfterSetup = await provider.getTransactionCount(wallet.address, 'latest');
  state.completedAt = new Date().toISOString();
  save();
  say(`setup complete; deployer nonce ${state.deployerNonceAfterSetup}; bytecode equal to artifact: ${state.bytecode.equal}`);
  say('self-scan: pass');
}

main().catch((error) => {
  // Both streams are flushed before exiting (pipes can be asynchronous).
  process.stderr.write(`deploy-sepolia failed: ${R.errorCode(error)}\n`,
    () => process.stdout.write('', () => process.exit(1)));
});
