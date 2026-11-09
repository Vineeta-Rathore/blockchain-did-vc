#!/usr/bin/env node
/**
 * Sepolia verification latency. Plain Node, no signer, read-only. Reads only SEPOLIA_RPC_URL (from the
 * environment or one line of --env <file>) and stops if it is missing.
 *
 *   node scripts/measure-sepolia.js --deployment results/sepolia_v1.1_deployment.json --log <log.jsonl> --env <file>
 *        [--pilot] [--block-lag 0|1] [--timeout-ms <ms>] [--only-block <k> --at <HH:MM>] [--no-wait]
 *
 * Schedule (IST): blocks at 08:00, 09:20, 10:40, 12:00, 13:20, 14:40, 16:00, 17:20, 18:40 and 20:00; each block has
 * 2 warm-up and 10 timed iterations; each iteration runs P, S, C and Bt in an order fixed by the block and the
 * iteration (scripts/lib/sepolia-modes.js, orderFor). A block that cannot start within 2 minutes of its time is logged
 * as missed (reserve slots: --only-block <k> --at 20:40 or 21:20). --pilot runs 3 labelled iterations at once.
 * --timeout-ms is the request timeout (default 30000). Sockets are kept open between requests and every new one is
 * counted (scripts/lib/rpc.js, installAgents). Every row is redacted and scanned before it is appended; every row
 * carries the run's start time (`run`), so rows of two runs never pair.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { ethers } = require('ethers');
const R = require('./lib/rpc');
const M = require('./lib/sepolia-modes');
const { CredentialVerifierService } = require('../src/vc/verifier-service');

const SLOTS = ['08:00', '09:20', '10:40', '12:00', '13:20', '14:40', '16:00', '17:20', '18:40', '20:00'];
const WARMUP = 2;
const TIMED = 10;
const START_WINDOW_MS = 2 * 60 * 1000;

const argError = (code) => Object.assign(new Error(code), { code });

// The commit of the checkout, with "-dirty" if tracked files differ from it; null outside a git checkout.
function commitDescribe() {
  try {
    return execFileSync('git', ['-C', path.join(__dirname, '..'), 'describe', '--always', '--dirty', '--abbrev=12'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(name);
const sleep = (t) => new Promise((resolve) => setTimeout(resolve, t));

function slotDate(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

async function main() {
  const url = R.readRpcUrl(arg('--env'));
  const redact = R.makeRedactor(url);
  R.installGuards(redact);
  if (!url) {
    console.error('SEPOLIA_RPC_URL is missing; stopping (no fallback endpoint).');
    process.exit(2);
  }
  const logPath = arg('--log');
  if (!logPath) throw argError('ARG_LOG_MISSING');
  const blockLag = Number(arg('--block-lag', '0'));
  if (!Number.isInteger(blockLag) || blockLag < 0) throw argError('ARG_BLOCK_LAG');
  const timeoutMs = Number(arg('--timeout-ms', '30000'));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100) throw argError('ARG_TIMEOUT');
  const deployment = JSON.parse(fs.readFileSync(arg('--deployment', 'results/sepolia_v1.1_deployment.json'), 'utf8'));
  const pilot = flag('--pilot');
  const say = R.makeWriter(redact, (t) => process.stdout.write(`${t}\n`));
  const append = R.makeWriter(redact, (t) => fs.appendFileSync(logPath, `${t}\n`));
  const write = (row) => append(JSON.stringify(row));

  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'DIDRegistry.sol', 'DIDRegistry.json'), 'utf8'));
  const iface = new ethers.utils.Interface(artifact.abi);
  // --expect-chain exists only for dry runs against a local node; the default is Sepolia.
  const expectedChain = Number(arg('--expect-chain', String(R.SEPOLIA.chainId)));
  const sockets = R.installAgents();
  const provider = R.makeProvider(url, {
    network: { name: expectedChain === R.SEPOLIA.chainId ? 'sepolia' : 'local', chainId: expectedChain }, timeoutMs,
  });
  const counter = R.requestCounter(provider);
  const credential = deployment.credentials.B;
  const address = deployment.address;
  const contract = new ethers.Contract(address, artifact.abi, provider);
  const verifier = new CredentialVerifierService(contract, { timing: true, provider, blockLag });
  const ctx = { provider, counter, sockets, verifier, credential, iface, address, blockLag,
    calls: M.readCalls(iface, address, credential) };

  // Before any timing: one chain-ID check and the deployer's nonce (read-only).
  const chainId = ethers.BigNumber.from(await provider.send('eth_chainId', [])).toNumber();
  if (chainId !== expectedChain) throw Object.assign(new Error('chain'), { code: 'WRONG_CHAIN' });
  const nonceStart = await provider.getTransactionCount(deployment.deployer, 'latest');

  const run = new Date().toISOString();
  write({
    kind: 'header',
    script: 'measure-sepolia.js',
    label: pilot ? 'pilot' : 'run',
    startedAt: run,
    commit: commitDescribe(),
    timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
    node: process.version,
    ethers: ethers.version,
    provider: R.providerLabel(url),
    chainId,
    contract: address,
    credentialB: credential.id,
    deployer: deployment.deployer,
    deployerNonceStart: nonceStart,
    blockLag,
    requestTimeoutMs: timeoutMs,
    agents: { keepAlive: true, scheduling: 'fifo', idleTimeoutMs: sockets.idleTimeoutMs },
    ...(arg('--only-block') ? { onlyBlock: Number(arg('--only-block')), at: arg('--at') } : {}),
    slots: pilot ? [] : SLOTS,
    warmup: pilot ? 0 : WARMUP,
    timed: pilot ? 3 : TIMED,
  });

  let blocks = SLOTS.map((slot, i) => ({ block: i + 1, slot }));
  if (arg('--only-block')) {
    const k = Number(arg('--only-block'));
    blocks = [{ block: k, slot: arg('--at') || SLOTS[k - 1], reserve: Boolean(arg('--at')) }];
  }
  if (pilot) blocks = [{ block: 0, slot: 'pilot' }];

  for (const b of blocks) {
    if (!pilot && !flag('--no-wait')) {
      const start = slotDate(b.slot).getTime();
      if (Date.now() > start + START_WINDOW_MS) {
        write({ kind: 'block_missed', run, block: b.block, slot: b.slot });
        say(`block ${b.block} (${b.slot}) missed`);
        continue;
      }
      while (Date.now() < start) await sleep(Math.min(30000, start - Date.now()));
      // The machine may have slept through the slot: a block that cannot start within its window is missed.
      if (Date.now() > start + START_WINDOW_MS) {
        write({ kind: 'block_missed', run, block: b.block, slot: b.slot, late: true });
        say(`block ${b.block} (${b.slot}) missed (started too late)`);
        continue;
      }
    }
    const startedAt = new Date().toISOString();
    const cold = await M.coldStart(provider);
    write({ kind: 'sepolia', run, mode: 'cold', block: b.block, slot: b.slot, coldStart: true, warmup: true, ...cold, at: startedAt });
    const warmups = pilot ? 0 : WARMUP;
    const timed = pilot ? 3 : TIMED;
    for (let i = 0; i < warmups + timed; i++) {
      const warm = i < warmups;
      const order = warm
        ? M.orderFor({ block: b.block, index: i, perBlock: warmups })
        : M.orderFor({ block: b.block, index: i - warmups, perBlock: timed });
      for (const mode of order) {
        const r = await M.runMode(mode, ctx);
        write({
          kind: 'sepolia', run, block: b.block, slot: b.slot, ...(b.reserve ? { reserve: true } : {}),
          iteration: i + 1, warmup: warm, pilot, order: order.join(','), ...r,
        });
      }
    }
    const cache = await M.cacheCheck(ctx, `urn:uuid:${crypto.randomUUID()}`);
    write({ kind: 'cache_check', run, block: b.block, slot: b.slot, ...cache });
    say(`block ${b.block} (${b.slot}) done`);
  }

  const nonceEnd = await provider.getTransactionCount(deployment.deployer, 'latest');
  write({ kind: 'footer', run, finishedAt: new Date().toISOString(), newSockets: sockets.newSockets, deployerNonceEnd: nonceEnd,
    nonceUnchanged: nonceEnd === nonceStart });
  const hits = R.scanText(fs.readFileSync(logPath, 'utf8'), [...R.secretParts(url)]);
  say(`self-scan: ${hits.length ? 'FAIL' : 'pass'}; deployer nonce ${nonceEnd === nonceStart ? 'unchanged' : 'CHANGED'}`);
  if (hits.length || nonceEnd !== nonceStart) process.exitCode = 1;
}

// Exit when the run is done: after an HTTP 429, ethers v5 leaves its request timer running for the full timeout.
main().then(
  () => process.stdout.write('', () => process.exit(process.exitCode || 0)),
  (error) => {
    process.stderr.write(`measure-sepolia failed: ${R.errorCode(error)}\n`, () => process.exit(1));
  },
);
