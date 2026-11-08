// The four measurement modes of plan D1-B. Each read is an eth_call pinned to one block (same-block reads).
//   P   full verification pipeline (the verifier reads the block number itself, step B0, inside the timer)
//   S   the four reads in sequence          (block number read just before the timer)
//   C   the four reads at once, as four HTTP requests
//   Bt  the four reads in one JSON-RPC batch, one HTTP request, built by hand (no batching delay)
// Responses of S, C and Bt are decoded after the timer stops.
const { ethers } = require('ethers');
const { errorCode } = require('./rpc');

const now = () => process.hrtime.bigint();
const ms = (a, b) => Number(b - a) / 1e6;

function readCalls(iface, address, credential) {
  const issuer = credential.issuer;
  const subject = credential.credentialSubject.id;
  return [
    { name: 'verifyDID', to: address, data: iface.encodeFunctionData('verifyDID', [issuer]) },
    { name: 'verifyDID', to: address, data: iface.encodeFunctionData('verifyDID', [subject]) },
    { name: 'getDIDDocument', to: address, data: iface.encodeFunctionData('getDIDDocument', [issuer]) },
    { name: 'isCredentialRevoked', to: address, data: iface.encodeFunctionData('isCredentialRevoked', [issuer, credential.id]) },
  ];
}

async function blockNumber(provider) {
  return ethers.BigNumber.from(await provider.send('eth_blockNumber', [])).toNumber();
}

async function pinnedBlock(provider, blockLag) {
  const t0 = now();
  const n = await blockNumber(provider);
  return { blockNumber: Math.max(0, n - blockLag), b0_ms: ms(t0, now()) };
}

const tag = (n) => ethers.utils.hexValue(n);

function decodeAndCheck(iface, calls, raw, credential) {
  const values = calls.map((c, i) => iface.decodeFunctionResult(c.name, raw[i])[0]);
  const [issuerActive, subjectActive, doc, revoked] = values;
  return issuerActive === true && subjectActive === true && doc.id === credential.issuer && doc.active === true &&
    revoked === false;
}

async function runS(provider, calls, blockNumberValue) {
  const raw = [];
  const reads = [];
  const t0 = now();
  for (const c of calls) {
    const r0 = now();
    raw.push(await provider.send('eth_call', [{ to: c.to, data: c.data }, tag(blockNumberValue)]));
    reads.push(ms(r0, now()));
  }
  return { total_ms: ms(t0, now()), reads_ms: reads, raw };
}

async function runC(provider, calls, blockNumberValue) {
  const t0 = now();
  const raw = await Promise.all(calls.map((c) => provider.send('eth_call', [{ to: c.to, data: c.data }, tag(blockNumberValue)])));
  return { total_ms: ms(t0, now()), raw };
}

async function runBt(connection, calls, blockNumberValue) {
  const body = JSON.stringify(calls.map((c, i) => ({
    jsonrpc: '2.0', id: i + 1, method: 'eth_call', params: [{ to: c.to, data: c.data }, tag(blockNumberValue)],
  })));
  const t0 = now();
  const response = await ethers.utils.fetchJson(connection, body);
  const total = ms(t0, now());
  if (!Array.isArray(response)) {
    const error = new Error('BATCH_NOT_ARRAY');
    error.code = 'BATCH_NOT_ARRAY';
    throw error;
  }
  const byId = new Map(response.map((r) => [r.id, r]));
  const raw = calls.map((c, i) => {
    const r = byId.get(i + 1);
    if (!r || r.error || r.result === undefined) {
      const error = new Error('BATCH_ITEM_ERROR');
      error.code = r && r.error && Number.isInteger(r.error.code) ? r.error.code : 'BATCH_ITEM_ERROR';
      throw error;
    }
    return r.result;
  });
  return { total_ms: total, raw };
}

async function runP(verifier, credential) {
  const t0 = now();
  const result = await verifier.verifyCredential(credential);
  const total = ms(t0, now());
  return {
    total_ms: total,
    b0_ms: result.timings ? result.timings.B0 : null,
    steps: result.timings || null,
    blockNumber: result.checkedAtBlock,
    valid: result.valid,
    reason: result.reason,
    ...(result.errorCode ? { error: result.errorCode } : {}),
  };
}

// One mode, with request counts (by method) and the chain-ID check during its window.
async function runMode(mode, ctx) {
  const before = ctx.counter.snapshot();
  try {
    if (mode === 'P') {
      const r = await runP(ctx.verifier, ctx.credential);
      const requests = ctx.counter.since(before);
      return { mode, ...r, requests, chainIdDuringTimer: requests.eth_chainId || 0 };
    }
    const pinned = await pinnedBlock(ctx.provider, ctx.blockLag);
    const timedBefore = ctx.counter.snapshot();
    let r;
    if (mode === 'S') r = await runS(ctx.provider, ctx.calls, pinned.blockNumber);
    else if (mode === 'C') r = await runC(ctx.provider, ctx.calls, pinned.blockNumber);
    else if (mode === 'Bt') r = await runBt(ctx.provider.connection, ctx.calls, pinned.blockNumber);
    else throw new Error('unknown mode');
    const duringTimer = ctx.counter.since(timedBefore);
    const sane = decodeAndCheck(ctx.iface, ctx.calls, r.raw, ctx.credential);
    return {
      mode,
      blockNumber: pinned.blockNumber,
      b0_ms: pinned.b0_ms,
      total_ms: r.total_ms,
      ...(r.reads_ms ? { reads_ms: r.reads_ms } : {}),
      sane,
      requests: { ...ctx.counter.since(before), ...(mode === 'Bt' ? { batch: 1 } : {}) },
      chainIdDuringTimer: duringTimer.eth_chainId || 0,
    };
  } catch (error) {
    return { mode, total_ms: null, error: errorCode(error), requests: ctx.counter.since(before) };
  }
}

const ORDERS = [['P', 'S', 'C', 'Bt'], ['S', 'C', 'Bt', 'P'], ['C', 'Bt', 'P', 'S'], ['Bt', 'P', 'S', 'C']];

async function coldStart(provider) {
  const t0 = now();
  try {
    await blockNumber(provider);
    return { cold_ms: ms(t0, now()) };
  } catch (error) {
    return { cold_ms: null, error: errorCode(error) };
  }
}

// Provider-side caching check: a read nobody has made before, timed beside the known read, at the same block.
async function cacheCheck(ctx, freshCredentialId) {
  try {
    const { blockNumber: n } = await pinnedBlock(ctx.provider, ctx.blockLag);
    const issuer = ctx.credential.issuer;
    const fresh = ctx.iface.encodeFunctionData('isCredentialRevoked', [issuer, freshCredentialId]);
    const known = ctx.iface.encodeFunctionData('isCredentialRevoked', [issuer, ctx.credential.id]);
    const t0 = now();
    await ctx.provider.send('eth_call', [{ to: ctx.address, data: fresh }, tag(n)]);
    const t1 = now();
    await ctx.provider.send('eth_call', [{ to: ctx.address, data: known }, tag(n)]);
    return { fresh_ms: ms(t0, t1), known_ms: ms(t1, now()), blockNumber: n };
  } catch (error) {
    return { fresh_ms: null, known_ms: null, error: errorCode(error) };
  }
}

module.exports = { ORDERS, blockNumber, cacheCheck, coldStart, readCalls, runBt, runC, runMode, runP, runS };
