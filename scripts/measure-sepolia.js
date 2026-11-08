#!/usr/bin/env node
/**
 * Sepolia verification latency (plan D1-B). Plain Node, no signer, read-only. Reads only SEPOLIA_RPC_URL (from the
 * environment or one line of --env <file>) and stops if it is missing.
 *
 *   node scripts/measure-sepolia.js --deployment results/sepolia_v1.1_deployment.json --log <log.jsonl> --env <file>
 *        [--pilot] [--block-lag 0|1] [--only-block <k> --at <HH:MM>] [--no-wait]
 *
 * Schedule (IST): blocks at 08:00, 09:20, 10:40, 12:00, 13:20, 14:40, 16:00, 17:20, 18:40 and 20:00; each block has
 * 2 warm-up and 10 timed iterations; each iteration runs P, S, C and Bt in a rotating order. A block that cannot start
 * within 2 minutes of its time is logged as missed (reserve slots: --only-block <k> --at 20:40 or 21:20).
 * --pilot runs 3 labelled iterations at once. Every row is redacted and scanned before it is appended.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');
const R = require('./lib/rpc');
const M = require('./lib/sepolia-modes');
const { CredentialVerifierService } = require('../src/vc/verifier-service');

const SLOTS = ['08:00', '09:20', '10:40', '12:00', '13:20', '14:40', '16:00', '17:20', '18:40', '20:00'];
const WARMUP = 2;
const TIMED = 10;
const START_WINDOW_MS = 2 * 60 * 1000;

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
  const deployment = JSON.parse(fs.readFileSync(arg('--deployment', 'results/sepolia_v1.1_deployment.json'), 'utf8'));
  const logPath = arg('--log');
  if (!logPath) throw new Error('--log is required');
  const pilot = flag('--pilot');
  const blockLag = Number(arg('--block-lag', '0'));
  const say = R.makeWriter(redact, (t) => process.stdout.write(`${t}\n`));
  const append = R.makeWriter(redact, (t) => fs.appendFileSync(logPath, `${t}\n`));
  const write = (row) => append(JSON.stringify(row));

  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'DIDRegistry.sol', 'DIDRegistry.json'), 'utf8'));
  const iface = new ethers.utils.Interface(artifact.abi);
  // --expect-chain exists only for dry runs against a local node; the default is Sepolia.
  const expectedChain = Number(arg('--expect-chain', String(R.SEPOLIA.chainId)));
  const provider = R.makeProvider(url, { network: { name: expectedChain === R.SEPOLIA.chainId ? 'sepolia' : 'local', chainId: expectedChain } });
  const counter = R.requestCounter(provider);
  const credential = deployment.credentials.B;
  const address = deployment.address;
  const contract = new ethers.Contract(address, artifact.abi, provider);
  const verifier = new CredentialVerifierService(contract, { timing: true, provider, blockLag });
  const ctx = { provider, counter, verifier, credential, iface, address, blockLag, calls: M.readCalls(iface, address, credential) };

  // Before any timing: one chain-ID check and the deployer's nonce (read-only).
  const chainId = ethers.BigNumber.from(await provider.send('eth_chainId', [])).toNumber();
  if (chainId !== expectedChain) throw Object.assign(new Error('chain'), { code: 'WRONG_CHAIN' });
  const nonceStart = await provider.getTransactionCount(deployment.deployer, 'latest');

  write({
    kind: 'header',
    script: 'measure-sepolia.js',
    label: pilot ? 'pilot' : 'run',
    startedAt: new Date().toISOString(),
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

  let iterationCounter = 0;
  for (const b of blocks) {
    if (!pilot && !flag('--no-wait')) {
      const start = slotDate(b.slot).getTime();
      if (Date.now() > start + START_WINDOW_MS) {
        write({ kind: 'block_missed', block: b.block, slot: b.slot });
        say(`block ${b.block} (${b.slot}) missed`);
        continue;
      }
      while (Date.now() < start) await sleep(Math.min(30000, start - Date.now()));
    }
    const startedAt = new Date().toISOString();
    const cold = await M.coldStart(provider);
    write({ kind: 'sepolia', mode: 'cold', block: b.block, slot: b.slot, coldStart: true, warmup: true, ...cold, at: startedAt });
    const total = (pilot ? 0 : WARMUP) + (pilot ? 3 : TIMED);
    for (let i = 0; i < total; i++) {
      const order = M.ORDERS[iterationCounter % M.ORDERS.length];
      iterationCounter += 1;
      for (const mode of order) {
        const r = await M.runMode(mode, ctx);
        write({
          kind: 'sepolia', block: b.block, slot: b.slot, ...(b.reserve ? { reserve: true } : {}),
          iteration: i + 1, warmup: !pilot && i < WARMUP, pilot, order: order.join(','), ...r,
        });
      }
    }
    const cache = await M.cacheCheck(ctx, `urn:uuid:${crypto.randomUUID()}`);
    write({ kind: 'cache_check', block: b.block, slot: b.slot, ...cache });
    say(`block ${b.block} (${b.slot}) done`);
  }

  const nonceEnd = await provider.getTransactionCount(deployment.deployer, 'latest');
  write({ kind: 'footer', finishedAt: new Date().toISOString(), deployerNonceEnd: nonceEnd, nonceUnchanged: nonceEnd === nonceStart });
  const hits = R.scanText(fs.readFileSync(logPath, 'utf8'), [...R.secretParts(url)]);
  say(`self-scan: ${hits.length ? 'FAIL' : 'pass'}; deployer nonce ${nonceEnd === nonceStart ? 'unchanged' : 'CHANGED'}`);
  if (hits.length || nonceEnd !== nonceStart) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`measure-sepolia failed: ${R.errorCode(error)}\n`);
  process.exit(1);
});
