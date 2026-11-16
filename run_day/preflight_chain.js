#!/usr/bin/env node
/**
 * Read-only chain preflight for the run day. It reads SEPOLIA_RPC_URL from one line of the env file (the artifact's own
 * readRpcUrl) and prints no part of it. It sends no transaction and loads no key.
 *
 *   node preflight_chain.js --root <artifact folder> --env <env file> --deployment <record> [--cu-limit <compute units per second>]
 *
 * Prints PASS, WARN and FAIL lines. Exit code 0 unless a line is FAIL.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const cuLimitArg = opt('--cu-limit');
const root = opt('--root');
const envFile = opt('--env');
const recordFile = opt('--deployment');
if (!root || !envFile || !recordFile) {
  console.error('usage: node preflight_chain.js --root <artifact> --env <env file> --deployment <record>');
  process.exit(2);
}
const R = require(path.join(root, 'scripts', 'lib', 'rpc.js'));
const { ethers } = require(path.join(root, 'node_modules', 'ethers'));
const { CredentialVerifierService } = require(path.join(root, 'src', 'vc', 'verifier-service'));

const FROZEN = { bytes: 13752, keccak: '0x355a986a5dcdb4a27681df3ca000a60bd2d3a526904c483d32c2870867710679' };
const CU_ITERATION = 4 * 10 + 16 * 26; // compute units of one iteration (P, S, C, Bt)
const ROUND_TRIPS = 14; // sequential round trips of one iteration: P 5, S 5, C 2, Bt 2
// The plan's throughput limit is unknown (review 19, M-05): the provider's pages give 300, 330, 500 and 1000 compute units per
// second over a 10 s window. 300 is the default here; the user reads the real value from the dashboard and passes it (--cu-limit).
const CU_LIMIT = cuLimitArg === null ? 300 : Number(cuLimitArg);
if (!(CU_LIMIT > 0)) { console.error('--cu-limit must be a positive number'); process.exit(2); }
const BUCKET_WINDOW_S = 10; // the window of that limit
// One block: 12 iterations of CU_ITERATION, the cold start (an eth_blockNumber, 10 CU) and the cache check (a block-number read and
// two eth_call, 10 + 2 x 26 CU): the same total as the checker's. Its sequential round trips: 12 x ROUND_TRIPS + 4.
const BLOCK_CU = 12 * CU_ITERATION + 10 + (10 + 2 * 26);
const BLOCK_ROUND_TRIPS = 12 * ROUND_TRIPS + 4;
// Two readings of how the limit is enforced. (1) A strict cap of CU_LIMIT x BUCKET_WINDOW_S in any 10 s window: the loop is
// refused (HTTP 429) whenever its average draw, CU_ITERATION / (ROUND_TRIPS x round trip), exceeds CU_LIMIT. (2) A token bucket
// that starts full (capacity CU_LIMIT x BUCKET_WINDOW_S) and refills at CU_LIMIT per second: a block, which draws BLOCK_CU over
// BLOCK_ROUND_TRIPS x round trip seconds, empties it if BLOCK_CU > CU_LIMIT x BUCKET_WINDOW_S + CU_LIMIT x BLOCK_ROUND_TRIPS x rtt.
const STRICT_RTT_MS = (CU_ITERATION / (ROUND_TRIPS * CU_LIMIT)) * 1000;
const BUCKET_RTT_MS = BLOCK_CU > CU_LIMIT * BUCKET_WINDOW_S ? ((BLOCK_CU - CU_LIMIT * BUCKET_WINDOW_S) / (CU_LIMIT * BLOCK_ROUND_TRIPS)) * 1000 : 0;
const SAMPLES = 10;

delete process.env.SEPOLIA_RPC_URL;
const lines = [];
let fails = 0;
let redact = (t) => t;
let finished = false;
const line = (level, text) => { lines.push(`${level.padEnd(4)} ${text}`); if (level === 'FAIL') fails += 1; };
const finish = () => {
  if (finished) return;
  finished = true;
  process.stdout.write(`${lines.map((l) => redact(l)).join('\n')}\n`, () => process.exit(fails ? 1 : 0));
};
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
// A crash must print what was collected and a FAIL line (rpc.js's installGuards would exit silently, and the preflight would
// then report no failure). Diagnostic reports stay off, as in the other scripts, and errors are reduced to codes.
if (process.report) {
  process.report.reportOnFatalError = false;
  process.report.reportOnSignal = false;
  process.report.reportOnUncaughtException = false;
}
const crash = (error) => { line('FAIL', `preflight_chain crashed: ${R.errorCode(error)}`); finish(); };
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

async function main() {
  let url = null;
  try { url = R.readRpcUrl(envFile); } catch { url = null; }
  if (!url) { line('FAIL', 'SEPOLIA_RPC_URL not found in the env file'); return finish(); }
  redact = R.makeRedactor(url);
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'contracts', 'DIDRegistry.sol', 'DIDRegistry.json'), 'utf8'));
  const sockets = R.installAgents();
  const provider = R.makeProvider(url, { timeoutMs: 30000 });
  line('INFO', `provider label ${R.providerLabel(url)}; local time ${new Date().toISOString()}`);

  const chainId = ethers.BigNumber.from(await provider.send('eth_chainId', [])).toNumber();
  line(chainId === 11155111 ? 'PASS' : 'FAIL', `chain id ${chainId} (Sepolia is 11155111)`);

  // Round trips: the first request opens the connection (DNS, TCP, TLS); the next ten reuse it, as the run does.
  const rtt = [];
  let errors = 0;
  for (let i = 0; i <= SAMPLES; i++) {
    const t0 = process.hrtime.bigint();
    try {
      await provider.send('eth_blockNumber', []);
      rtt.push(Number(process.hrtime.bigint() - t0) / 1e6);
    } catch (error) {
      errors += 1;
      line('FAIL', `eth_blockNumber request ${i + 1} failed: ${R.errorCode(error)}`);
    }
  }
  if (rtt.length > 1) {
    const first = rtt[0];
    const rest = rtt.slice(1);
    const med = median(rest);
    const predicted = CU_ITERATION / (ROUND_TRIPS * med / 1000);
    line(errors === 0 ? 'PASS' : 'FAIL', `${rtt.length} eth_blockNumber requests, ${errors} failed; first (with connection set-up) ${first.toFixed(0)} ms; next ${rest.length}: min ${Math.min(...rest).toFixed(0)}, median ${med.toFixed(0)}, max ${Math.max(...rest).toFixed(0)} ms`);
    line(predicted > CU_LIMIT ? 'WARN' : 'PASS',
      `predicted draw of the measurement loop ${predicted.toFixed(0)} CU/s (${CU_ITERATION} CU in ${ROUND_TRIPS} round trips of ${med.toFixed(0)} ms) against a limit of ${CU_LIMIT} CU/s over a ${BUCKET_WINDOW_S} s window (${cuLimitArg === null ? 'the default; the real limit of the plan is unknown, pass --cu-limit' : 'given with --cu-limit'}); HTTP 429 would be expected at round trips below about ${STRICT_RTT_MS.toFixed(0)} ms if the limit is a strict cap in any ${BUCKET_WINDOW_S} s window, ${BUCKET_RTT_MS > 0 ? `and below about ${BUCKET_RTT_MS.toFixed(0)} ms if it is a token bucket that starts full (a block draws ${BLOCK_CU} CU)` : `and never if it is a token bucket that starts full (the bucket holds more than the ${BLOCK_CU} CU of a block)`}; this line is recorded and never changes the run`);
  }

  const block = await provider.send('eth_getBlockByNumber', ['latest', false]);
  const ageS = Date.now() / 1000 - ethers.BigNumber.from(block.timestamp).toNumber();
  line(Math.abs(ageS) <= 60 ? 'PASS' : 'WARN', `latest block ${ethers.BigNumber.from(block.number).toString()}, its timestamp is ${ageS.toFixed(0)} s before the local clock (a large value means a stale head or a wrong clock); base fee ${ethers.BigNumber.from(block.baseFeePerGas).toString()} wei`);

  const nonce = ethers.BigNumber.from(await provider.send('eth_getTransactionCount', [record.deployer, 'latest'])).toNumber();
  line(nonce === record.deployerNonceAfterSetup ? 'PASS' : 'FAIL', `deployer nonce ${nonce} equals the recorded ${record.deployerNonceAfterSetup} (it must not change during the run)`);

  const code = await provider.send('eth_getCode', [record.address, 'latest']);
  const bytes = (code.length - 2) / 2;
  line(bytes === FROZEN.bytes && ethers.utils.keccak256(code) === FROZEN.keccak ? 'PASS' : 'FAIL', `runtime code at ${record.address}: ${bytes} bytes, keccak256 ${ethers.utils.keccak256(code).slice(0, 12)}... (frozen: ${FROZEN.bytes} bytes, ${FROZEN.keccak.slice(0, 12)}...)`);
  line(code.toLowerCase() === artifact.deployedBytecode.toLowerCase() ? 'PASS' : 'FAIL', 'runtime code equals the compiled artifact');

  const contract = new ethers.Contract(record.address, artifact.abi, provider);
  const verifier = new CredentialVerifierService(contract, { timing: true, provider, blockLag: 0 });
  const result = await verifier.verifyCredential(record.credentials.B);
  line(result.valid === true ? 'PASS' : 'FAIL', `credential B through the pipeline at lag 0: valid ${result.valid}, reason ${result.reason}, block ${result.checkedAtBlock}`);

  line('INFO', `new sockets opened by this preflight: ${sockets.newSockets}`);
  sockets.restore();
  return finish();
}

main().catch(crash);
