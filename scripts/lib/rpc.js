// Network helpers for the Sepolia scripts, with the rules for secrets:
// - The RPC URL is read from SEPOLIA_RPC_URL or from one line of a given env file; nothing else in that file is read.
// - Every string a script writes passes through redact(), which removes the URL's userinfo, path and query.
// - Errors are reduced to codes; error.message, error.url, error.body and error.stack are never written.
// - Requests are never retried (throttleLimit 1); the network is fixed, so no eth_chainId is sent before calls.
const fs = require('fs');
const { ethers } = require('ethers');

const SEPOLIA = { name: 'sepolia', chainId: 11155111 };
const BANNED = ['secretKeyMultibase', 'privateKeyMultibase', 'z3u2'];

function readRpcUrl(envFile) {
  if (process.env.SEPOLIA_RPC_URL) return process.env.SEPOLIA_RPC_URL.trim();
  if (!envFile) return null;
  const line = fs.readFileSync(envFile, 'utf8').split(/\r?\n/).find((l) => /^\s*SEPOLIA_RPC_URL\s*=/.test(l));
  if (!line) return null;
  return line.replace(/^\s*SEPOLIA_RPC_URL\s*=\s*/, '').replace(/^["']|["']$/g, '').trim() || null;
}

// Parts of the URL that must never be written: the whole URL, userinfo, path and query.
function secretParts(url) {
  const parts = new Set();
  if (!url) return parts;
  parts.add(url);
  try {
    const u = new URL(url);
    if (u.username) parts.add(u.username);
    if (u.password) parts.add(u.password);
    if (u.pathname && u.pathname !== '/') {
      parts.add(u.pathname);
      for (const segment of u.pathname.split('/')) if (segment.length >= 6) parts.add(segment);
    }
    if (u.search) {
      parts.add(u.search);
      for (const [, value] of u.searchParams) if (value.length >= 6) parts.add(value);
    }
  } catch {
    // an unparsable URL is still removed as a whole
  }
  return parts;
}

function makeRedactor(url, extraSecrets = []) {
  const parts = [...secretParts(url), ...extraSecrets.filter(Boolean)].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text);
    for (const part of parts) out = out.split(part).join('[redacted]');
    // any other URL keeps only its scheme and host
    return out.replace(/(https?:\/\/[^/\s"'<>]+)[^\s"'<>]*/g, '$1/[redacted]');
  };
}

// The host is logged only when it is not account-specific (no long token in it).
function providerLabel(url) {
  try {
    const host = new URL(url).hostname;
    return /[a-z0-9]{16,}/i.test(host.replace(/\./g, '')) && /\d/.test(host) ? 'custom-rpc' : host;
  } catch {
    return 'unparsable-rpc-url';
  }
}

function errorCode(error) {
  const code = error && error.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  if (typeof code === 'number' && Number.isInteger(code)) return `RPC_${code}`;
  if (error && Number.isInteger(error.status)) return `HTTP_${error.status}`;
  return 'UNKNOWN_ERROR';
}

function connectionInfo(url, timeoutMs = 30000) {
  return { url, throttleLimit: 1, timeout: timeoutMs };
}

// ethers v5's JsonRpcProvider.send reuses an eth_blockNumber or eth_chainId request made in the same event-loop turn
// (a cache cleared by setTimeout). The block number (step B0) must be a fresh request every time, so the cache entry
// is dropped before each send.
class UncachedStaticJsonRpcProvider extends ethers.providers.StaticJsonRpcProvider {
  send(method, params) {
    if (this._cache) delete this._cache[method];
    return super.send(method, params);
  }
}

function makeProvider(url, { network = SEPOLIA, timeoutMs } = {}) {
  return new UncachedStaticJsonRpcProvider(connectionInfo(url, timeoutMs), network);
}

// Counts requests by JSON-RPC method only. ethers v5 delivers its "debug" events through setTimeout, so a request
// can be counted after the next mode has started; counting inside provider.send is synchronous and exact.
function requestCounter(provider) {
  const counts = {};
  const send = provider.send.bind(provider);
  provider.send = (method, params) => {
    if (typeof method === 'string') counts[method] = (counts[method] || 0) + 1;
    return send(method, params);
  };
  return {
    snapshot: () => ({ ...counts }),
    since: (before) => {
      const d = {};
      for (const [k, v] of Object.entries(counts)) if (v - (before[k] || 0)) d[k] = v - (before[k] || 0);
      return d;
    },
  };
}

// Writes go through one function: redact, scan, then write. A scan hit stops the write.
function makeWriter(redact, sink) {
  return (text) => {
    const clean = redact(text);
    if (BANNED.some((b) => clean.includes(b))) throw new Error('SELF_SCAN_FAILED');
    sink(clean);
    return clean;
  };
}

// Global handlers that write only a redacted code; diagnostic reports stay off.
function installGuards(redact) {
  if (process.report) {
    process.report.reportOnFatalError = false;
    process.report.reportOnSignal = false;
    process.report.reportOnUncaughtException = false;
  }
  const handler = (error) => {
    process.stderr.write(`${redact(`fatal: ${errorCode(error)}`)}\n`);
    process.exit(1);
  };
  process.on('uncaughtException', handler);
  process.on('unhandledRejection', handler);
}

function scanText(text, secrets) {
  const hits = BANNED.filter((b) => text.includes(b));
  for (const s of secrets) if (s && text.includes(s)) hits.push('a secret value');
  return hits;
}

module.exports = {
  BANNED,
  SEPOLIA,
  connectionInfo,
  errorCode,
  installGuards,
  makeProvider,
  makeRedactor,
  makeWriter,
  providerLabel,
  readRpcUrl,
  requestCounter,
  scanText,
  secretParts,
};
