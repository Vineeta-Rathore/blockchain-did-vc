// Leak tests: a local server at http://127.0.0.1:<port>/v3/<fake-token> answers HTTP 429, HTTP 500, a
// timeout and a dropped connection. For every mode of the Sepolia scripts, the result objects, the written rows and
// the console must contain neither the fake token nor the path, and no request may be retried.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { expect } = require('chai');
const { ethers } = require('ethers');
const R = require('../scripts/lib/rpc');
const M = require('../scripts/lib/sepolia-modes');
const { CredentialVerifierService } = require('../src/vc/verifier-service');

const TOKEN = 'FAKE0TOKEN0abcdef0123456789';
const ABI = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'DIDRegistry.sol', 'DIDRegistry.json'), 'utf8')).abi;
const CREDENTIAL = {
  id: 'urn:uuid:00000000-0000-4000-8000-000000000000',
  issuer: 'did:smid:issuer-leak-test',
  credentialSubject: { id: 'did:smid:subject-leak-test' },
  proof: { verificationMethod: 'did:smid:issuer-leak-test#key-1' },
};

function startServer(behaviour) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    req.on('data', () => {});
    req.on('end', () => {
      if (behaviour === '429') {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        res.end('{"jsonrpc":"2.0","error":{"code":429,"message":"rate limited"}}');
      } else if (behaviour === '500') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('internal error');
      } else if (behaviour === 'drop') {
        req.socket.destroy();
      } // 'timeout': never answer
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    url: `http://127.0.0.1:${server.address().port}/v3/${TOKEN}`,
    hits: () => hits,
  })));
}

function captureConsole() {
  const lines = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(original)) console[k] = (...a) => lines.push(a.join(' '));
  return { lines, restore: () => Object.assign(console, original) };
}

const clean = (text) => !text.includes(TOKEN) && !text.includes('/v3/');

describe('leak tests: RPC failures never reveal the URL and are never retried', function () {
  this.timeout(60000);

  for (const behaviour of ['429', '500', 'timeout', 'drop']) {
    it(`HTTP ${behaviour}: every mode fails cleanly with one request each`, async function () {
      const { server, url, hits } = await startServer(behaviour);
      const capture = captureConsole();
      try {
        const redact = R.makeRedactor(url);
        const written = [];
        const write = R.makeWriter(redact, (t) => written.push(t));
        const provider = R.makeProvider(url, { network: { name: 'local', chainId: 1337 }, timeoutMs: 1500 });
        const counter = R.requestCounter(provider);
        const iface = new ethers.utils.Interface(ABI);
        const address = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
        const contract = new ethers.Contract(address, ABI, provider);
        const verifier = new CredentialVerifierService(contract, { timing: true, provider });
        const ctx = { provider, counter, verifier, credential: CREDENTIAL, iface, address, blockLag: 0,
          calls: M.readCalls(iface, address, CREDENTIAL) };

        for (const mode of ['P', 'S', 'C', 'Bt']) {
          const before = hits();
          const row = await M.runMode(mode, ctx);
          expect(hits() - before, `${mode}: HTTP requests`).to.equal(1);
          if (mode === 'P') {
            expect(row.valid).to.equal(false);
            expect(row.reason).to.equal('VERIFICATION_ERROR');
          } else {
            expect(row.total_ms).to.equal(null);
          }
          expect(row.error).to.be.a('string');
          write(JSON.stringify(row));
        }
        const cold = await M.coldStart(provider);
        write(JSON.stringify(cold));

        // The raw library error does carry the URL; the redactor must remove it from every field.
        let raw;
        try {
          await provider.send('eth_blockNumber', []);
        } catch (error) {
          raw = error;
        }
        expect(raw).to.not.equal(undefined);
        for (const text of [raw.message, String(raw.url), raw.stack, JSON.stringify(raw)]) {
          expect(clean(redact(text)), 'redacted error text').to.equal(true);
        }

        const everything = [...written, ...capture.lines].join('\n');
        expect(clean(everything), 'rows and console').to.equal(true);
      } finally {
        capture.restore();
        server.close();
      }
    });
  }

  it('the redactor keeps only the scheme and host of any URL', function () {
    const url = `https://user:pass@rpc.example.org/v3/${TOKEN}?key=SECRETQUERYVALUE`;
    const redact = R.makeRedactor(url);
    const out = redact(`failed: ${url} and https://other.example.net/path/${TOKEN}`);
    expect(out).to.not.include(TOKEN);
    expect(out).to.not.include('SECRETQUERYVALUE');
    expect(out).to.not.include('pass');
    expect(out).to.include('https://other.example.net/[redacted]');
  });

  it('the writer refuses to write a secret key field', function () {
    const write = R.makeWriter((t) => t, () => {});
    expect(() => write('{"secretKeyMultibase":"x"}')).to.throw('SELF_SCAN_FAILED');
  });
});
