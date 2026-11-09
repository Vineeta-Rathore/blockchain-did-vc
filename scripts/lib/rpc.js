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
  const value = line
    .replace(/^\s*SEPOLIA_RPC_URL\s*=\s*/, '')
    .replace(/\s+#.*$/, '') // an inline comment after the value
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  return value || null;
}

const HEX = /^(0x)?[0-9a-fA-F]+$/;

// A URL part counts as a secret when it looks like a credential: 8 characters or more with both letters and digits
// (hex keys, base62 keys, UUIDs), or 20 or more with both cases. Ordinary words in a host, path or query ("sepolia",
// "ethereum-sepolia-rpc", "network") are not secrets: treating them as secrets would blank the log's own fields, such
// as "kind": "sepolia". A query value is also a secret when its name says it is a key. The whole URL is always a
// secret, and so are the full path and query when they hold a token.
function looksLikeToken(value) {
  if (typeof value !== 'string') return false;
  return (value.length >= 8 && /\d/.test(value) && /[A-Za-z]/.test(value)) ||
    (value.length >= 20 && /[a-z]/.test(value) && /[A-Z]/.test(value));
}

// Parts of the URL that must never be written.
function secretParts(url) {
  const parts = new Set();
  if (!url) return parts;
  parts.add(url);
  try {
    const u = new URL(url);
    for (const info of [u.username, u.password]) {
      const value = decodeURIComponent(info || '');
      if (value.length >= 4) parts.add(value);
    }
    for (const label of u.hostname.split('.')) if (looksLikeToken(label)) parts.add(label);
    const pathTokens = u.pathname.split('/').filter(looksLikeToken);
    pathTokens.forEach((token) => parts.add(token));
    if (pathTokens.length) parts.add(u.pathname);
    // a query value is a secret if it looks like a token, or if its name says it is a key, whatever its shape
    const queryTokens = [...u.searchParams.entries()]
      .filter(([name, value]) => looksLikeToken(value) || (/key|token|secret|auth|pass|cred/i.test(name) && value.length >= 4))
      .map(([, value]) => value);
    queryTokens.forEach((token) => parts.add(token));
    if (queryTokens.length) parts.add(u.search);
  } catch {
    // an unparsable URL is still removed as a whole
  }
  return parts;
}

function makeRedactor(url, extraSecrets = []) {
  const variants = new Set();
  for (const part of [...secretParts(url), ...extraSecrets.filter(Boolean)]) {
    variants.add(part);
    if (HEX.test(part)) {
      const digits = part.replace(/^0x/, '');
      for (const v of [digits.toLowerCase(), digits.toUpperCase()]) variants.add(v);
    }
  }
  const parts = [...variants].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text);
    for (const part of parts) out = out.split(part).join('[redacted]');
    // any other URL keeps only its scheme and host: user information, path and query are removed
    return out.replace(/(https?:\/\/)(?:[^@/\s"'<>]*@)?([^/\s"'<>?#]+)[^\s"'<>]*/g, '$1$2/[redacted]');
  };
}

// The host is logged only when none of its labels looks like a token.
function providerLabel(url) {
  try {
    const host = new URL(url).hostname;
    return host.split('.').some(looksLikeToken) ? 'custom-rpc' : host;
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
    if (BANNED.some((b) => clean.includes(b))) throw Object.assign(new Error('SELF_SCAN_FAILED'), { code: 'SELF_SCAN_FAILED' });
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
  const lower = text.toLowerCase();
  for (const secret of secrets) {
    if (!secret) continue;
    const found = HEX.test(secret)
      ? lower.includes(secret.toLowerCase().replace(/^0x/, ''))
      : text.includes(secret);
    if (found) hits.push('a secret value');
  }
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
