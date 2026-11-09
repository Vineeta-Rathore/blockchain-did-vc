/**
 * Local verification latency: the full verification pipeline against the Hardhat in-process network.
 * One process = 100 warm-up and 20 timed verifications of one valid credential; run it five times as separate
 * processes for n = 100. Every timed and warm-up row is appended to the log (warm-up rows are flagged).
 *
 *   LOCAL_LOG=results/local_<date>_n100.jsonl PROCESS_INDEX=1 npx hardhat run scripts/measure-local.js
 *
 * The client uses a fixed network (no chain-ID request before each call). Per-step times (B0, V1-V8) are recorded
 * when the verifier supports them (version 1.1.0). The script also runs on a version 1.0.0 checkout with
 * scripts/lib/fixtures.js copied next to it (to time version 1.0.0 with this harness): that verifier has no per-step times and no
 * checkedAtBlock, so only the totals are recorded. For that reason the script needs nothing else from scripts/lib.
 */
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const hre = require('hardhat');
const { ethers } = hre;
const { VerifiableCredentialService } = require('../src/vc/vc-service');
const { CredentialVerifierService } = require('../src/vc/verifier-service');
const { didDocumentInputs, randomDidId } = require('./lib/fixtures');

const WARMUP = 100;
const TIMED = 20;
// The same list as scripts/lib/rpc.js, kept here so that the script needs no other file (see above).
const BANNED = ['secretKeyMultibase', 'privateKeyMultibase', 'z3u2'];

// ethers v5 re-detects the network (eth_chainId) before calls unless the provider caches it, as
// StaticJsonRpcProvider does. This wrapper does the same over Hardhat's EIP-1193 provider.
class FixedNetworkProvider extends ethers.providers.Web3Provider {
  async detectNetwork() {
    if (!this._fixedNetwork) this._fixedNetwork = await super.detectNetwork();
    return this._fixedNetwork;
  }
}

function safeExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function header(processIndex) {
  const powerScheme = os.platform() === 'win32' ? safeExec('powercfg', ['/getactivescheme']) : null;
  return {
    kind: 'header',
    script: 'measure-local.js',
    processIndex,
    startedAt: new Date().toISOString(),
    // "-dirty" if tracked files differ from the commit
    commit: safeExec('git', ['describe', '--always', '--dirty', '--abbrev=12']),
    node: process.version,
    hardhat: require('hardhat/package.json').version,
    ethers: ethers.version,
    hardfork: hre.config.networks.hardhat.hardfork || 'default',
    solc: hre.config.solidity.compilers[0].version,
    os: `${os.type()} ${os.release()}`,
    cpu: os.cpus()[0] && os.cpus()[0].model,
    cpuCount: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 2 ** 30),
    // Only the scheme's name, never a user or host name.
    powerScheme: powerScheme ? (powerScheme.match(/\(([^)]+)\)/) || [null, null])[1] : null,
    warmup: WARMUP,
    timed: TIMED,
  };
}

async function main() {
  if (hre.network.name !== 'hardhat') throw new Error('measure-local runs on the Hardhat network only');
  const logPath = process.env.LOCAL_LOG;
  const processIndex = Number(process.env.PROCESS_INDEX || 1);
  if (!logPath) throw new Error('set LOCAL_LOG');

  const [issuerSigner, holderSigner] = await ethers.getSigners();
  const registry = await (await ethers.getContractFactory('DIDRegistry')).deploy();
  await registry.deployed();

  const issuerKeys = VerifiableCredentialService.generateEd25519KeyPair();
  const holderKeys = VerifiableCredentialService.generateEd25519KeyPair();
  const issuer = didDocumentInputs({ didId: randomDidId(), publicKeyMultibase: issuerKeys.publicKeyMultibase, withService: true });
  const holder = didDocumentInputs({ didId: randomDidId(), publicKeyMultibase: holderKeys.publicKeyMultibase, withService: false });
  await (await registry.connect(issuerSigner).createDID(issuer.didId, issuer.verificationMethods, issuer.services, issuer.dataHash)).wait();
  await (await registry.connect(holderSigner).createDID(holder.didId, holder.verificationMethods, holder.services, holder.dataHash)).wait();

  const credential = VerifiableCredentialService.issueCredential({
    issuerDid: issuer.didId,
    subjectDid: holder.didId,
    privateKeyMultibase: issuerKeys.privateKeyMultibase,
    verificationMethod: JSON.parse(issuer.verificationMethods[0]),
    registryAddress: registry.address,
    claims: { name: 'Verified Identity', role: 'verified-account' },
  });

  const provider = new FixedNetworkProvider(hre.network.provider, { name: 'hardhat', chainId: hre.network.config.chainId });
  const readOnly = new ethers.Contract(registry.address, registry.interface, provider);
  const verifier = new CredentialVerifierService(readOnly, { timing: true, provider });

  const rows = [header(processIndex)];
  for (let i = 0; i < WARMUP + TIMED; i++) {
    const start = process.hrtime.bigint();
    const result = await verifier.verifyCredential(credential);
    const totalMs = Number(process.hrtime.bigint() - start) / 1e6;
    rows.push({
      kind: 'local',
      process: processIndex,
      iteration: i + 1,
      warmup: i < WARMUP,
      valid: result.valid,
      reason: result.reason,
      total_ms: totalMs,
      ...(result.timings ? { steps: result.timings } : {}),
      // version 1.0.0's verifier reports no block
      ...(result.checkedAtBlock !== undefined ? { block: result.checkedAtBlock } : {}),
    });
  }

  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const found = BANNED.filter((s) => text.includes(s));
  if (found.length) throw new Error('self-scan failed; nothing written');
  fs.appendFileSync(logPath, text);
  const timed = rows.filter((r) => r.kind === 'local' && !r.warmup);
  const invalid = timed.filter((r) => !r.valid).length;
  console.log(`process ${processIndex}: ${timed.length} timed rows appended, ${invalid} not valid; self-scan pass`);
  if (invalid) process.exitCode = 1;
}

main().catch((error) => {
  // Hardhat network only (checked above), so the message cannot contain an RPC URL.
  console.error(`measure-local failed: ${error && error.message}`);
  process.exit(1);
});
