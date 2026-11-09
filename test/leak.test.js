// Leak tests. A local server at http://127.0.0.1:<port>/sepolia/<fake-token> fails requests with HTTP 429, HTTP 500,
// a timeout or a dropped connection, either every request or only the contract reads (eth_call and the batch, after
// answering the block number). Checked:
// - in-process, for every measurement mode: the raw row (before redaction) holds error codes only, never the token or
//   the path; nothing is retried (exact request counts);
// - end to end, by running scripts/measure-sepolia.js and scripts/deploy-sepolia.js as child processes with the fake
//   URL and a fake deployer key: their raw stdout, stderr, log and record never contain the token, the path or the key.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { expect } = require('chai');
const { ethers } = require('ethers');
const R = require('../scripts/lib/rpc');
const M = require('../scripts/lib/sepolia-modes');
const { CredentialVerifierService } = require('../src/vc/verifier-service');

const TOKEN = 'FAKE0TOKEN0abcdef0123456789';
const ROOT = path.join(__dirname, '..');
const ABI = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts', 'contracts', 'DIDRegistry.sol', 'DIDRegistry.json'), 'utf8')).abi;
const ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const CREDENTIAL = {
  '@context': ['https://www.w3.org/ns/credentials/v2', 'https://w3id.org/security/data-integrity/v2'],
  type: ['VerifiableCredential'],
  id: 'urn:uuid:00000000-0000-4000-8000-000000000000',
  issuer: 'did:smid:issuer-leak-test',
  credentialSubject: { id: 'did:smid:subject-leak-test' },
  proof: { verificationMethod: 'did:smid:issuer-leak-test#key-1' },
};

// Answers for the requests the scripts make before any contract read.
const ANSWERS = {
  eth_chainId: '0x539',
  eth_blockNumber: '0x10',
  eth_getTransactionCount: '0x0',
  eth_getBalance: '0x0',
};

function startServer(behaviour) {
  const failAll = !behaviour.startsWith('call-');
  const failure = behaviour.replace(/^call-/, '');
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let request = null;
      try {
        request = JSON.parse(body);
      } catch {
        // not JSON: treated as a failing request
      }
      const answer = !failAll && request && !Array.isArray(request) && ANSWERS[request.method];
      if (answer) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: answer }));
      } else if (failure === '429') {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        res.end('{"jsonrpc":"2.0","error":{"code":429,"message":"rate limited"}}');
      } else if (failure === '500') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('internal error');
      } else if (failure === 'drop') {
        req.socket.destroy();
      } // 'timeout': never answer
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    url: `http://127.0.0.1:${server.address().port}/sepolia/${TOKEN}`,
    hits: () => hits,
  })));
}

// Captures everything written to the console and to the process streams while a test runs.
function captureOutput() {
  const lines = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  const writes = { out: process.stdout.write, err: process.stderr.write };
  for (const k of Object.keys(original)) console[k] = (...a) => lines.push(a.join(' '));
  process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return writes.out.call(process.stdout, '', ...rest); };
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return writes.err.call(process.stderr, '', ...rest); };
  return {
    lines,
    restore: () => {
      Object.assign(console, original);
      process.stdout.write = writes.out;
      process.stderr.write = writes.err;
    },
  };
}

const clean = (text) => !text.includes(TOKEN) && !text.includes('/sepolia/FAKE');

function runScript(script, args, url) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT, timeout: 120000, env: { ...process.env, SEPOLIA_RPC_URL: url },
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

describe('leak tests: RPC failures never reveal the URL and are never retried', function () {
  this.timeout(120000);

  // Requests per mode: B0 (eth_blockNumber) then the reads. If B0 fails, each mode stops after 1 request. If only the
  // reads fail: P and S stop at their first read (2), C sends its four reads at once (5), Bt sends one batch (2).
  const expectedRequests = {
    all: { P: 1, S: 1, C: 1, Bt: 1 },
    call: { P: 2, S: 2, C: 5, Bt: 2 },
  };

  for (const behaviour of ['429', '500', 'timeout', 'drop', 'call-429', 'call-500', 'call-timeout', 'call-drop']) {
    it(`${behaviour}: every mode fails cleanly, without retries, and its raw row holds only codes`, async function () {
      const { server, url, hits } = await startServer(behaviour);
      const capture = captureOutput();
      try {
        const redact = R.makeRedactor(url);
        const written = [];
        const write = R.makeWriter(redact, (t) => written.push(t));
        const provider = R.makeProvider(url, { network: { name: 'local', chainId: 1337 }, timeoutMs: 1500 });
        const counter = R.requestCounter(provider);
        const iface = new ethers.utils.Interface(ABI);
        const contract = new ethers.Contract(ADDRESS, ABI, provider);
        const verifier = new CredentialVerifierService(contract, { timing: true, provider });
        const ctx = { provider, counter, verifier, credential: CREDENTIAL, iface, address: ADDRESS, blockLag: 0,
          calls: M.readCalls(iface, ADDRESS, CREDENTIAL) };
        const expected = expectedRequests[behaviour.startsWith('call-') ? 'call' : 'all'];

        for (const mode of ['P', 'S', 'C', 'Bt']) {
          const before = hits();
          const row = await M.runMode(mode, ctx);
          // Mode C ends at its first failed read while the other reads are still in flight; let them arrive before
          // counting. A retry would still show as a count above the expected one.
          await new Promise((resolve) => setTimeout(resolve, 300));
          expect(hits() - before, `${mode}: HTTP requests`).to.equal(expected[mode]);
          if (mode === 'P') {
            expect(row.valid).to.equal(false);
            expect(row.reason).to.equal('VERIFICATION_ERROR');
          } else {
            expect(row.total_ms).to.equal(null);
          }
          expect(row.error).to.be.a('string');
          expect(clean(JSON.stringify(row)), `${mode}: raw row`).to.equal(true);
          write(JSON.stringify(row));
        }
        const cold = await M.coldStart(provider);
        expect(clean(JSON.stringify(cold)), 'raw cold-start row').to.equal(true);
        write(JSON.stringify(cold));

        // The raw library error does carry the URL; the redactor must remove it from every field.
        let raw;
        try {
          await provider.send('eth_call', [{ to: ADDRESS, data: '0x' }, '0x10']);
        } catch (error) {
          raw = error;
        }
        expect(raw).to.not.equal(undefined);
        for (const text of [raw.message, String(raw.url), raw.stack, JSON.stringify(raw)]) {
          expect(clean(redact(text)), 'redacted error text').to.equal(true);
        }

        const everything = [...written, ...capture.lines].join('\n');
        expect(clean(everything), 'rows and output').to.equal(true);
      } finally {
        capture.restore();
        server.close();
      }
    });
  }

  describe('the scripts themselves, run as child processes', function () {
    let dir;
    let fakeKey;
    beforeEach(function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-test-'));
      fakeKey = ethers.Wallet.createRandom();
      fs.writeFileSync(path.join(dir, 'deployment.json'), JSON.stringify({
        address: ADDRESS, deployer: fakeKey.address, credentials: { B: CREDENTIAL },
      }));
      fs.writeFileSync(path.join(dir, 'key.json'), JSON.stringify({ address: fakeKey.address, privateKey: fakeKey.privateKey }));
    });
    afterEach(function () {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const noKey = (text) => !text.toLowerCase().includes(fakeKey.privateKey.slice(2).toLowerCase());
    const files = () => fs.readdirSync(dir).filter((f) => !['deployment.json', 'key.json'].includes(f))
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

    for (const behaviour of ['500', 'call-429']) {
      it(`measure-sepolia.js --pilot, ${behaviour}: output and log hold no token or path`, async function () {
        const { server, url } = await startServer(behaviour);
        try {
          const log = path.join(dir, 'pilot.jsonl');
          const r = await runScript('measure-sepolia.js', ['--deployment', path.join(dir, 'deployment.json'), '--log', log,
            '--pilot', '--expect-chain', '1337'], url);
          const logText = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
          expect(clean(r.stdout + r.stderr + logText), 'stdout, stderr and log').to.equal(true);
          if (behaviour === '500') {
            expect(r.code).to.equal(1);
            expect(r.stderr).to.match(/^measure-sepolia failed: [A-Z0-9_]+\s*$/);
          } else {
            expect(r.code).to.equal(0);
            expect(logText).to.include('"kind":"sepolia"');
            expect(r.stdout).to.include('self-scan: pass');
          }
        } finally {
          server.close();
        }
      });

      it(`deploy-sepolia.js, ${behaviour}: output and files hold no token, path or key`, async function () {
        const { server, url } = await startServer(behaviour);
        try {
          const r = await runScript('deploy-sepolia.js', ['--key', path.join(dir, 'key.json'), '--out', path.join(dir, 'record.json'),
            '--secrets-dir', path.join(dir, 'secrets'), '--expect-chain', '1337'], url);
          const text = r.stdout + r.stderr + files();
          expect(clean(text), 'stdout, stderr and files').to.equal(true);
          expect(noKey(text), 'deployer key').to.equal(true);
          expect(r.code).to.equal(1);
          expect(r.stderr).to.match(/^deploy-sepolia failed: [A-Z0-9_]+\s*$/);
          if (behaviour === 'call-429') expect(r.stderr).to.include('BALANCE_TOO_LOW');
        } finally {
          server.close();
        }
      });
    }
  });

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
