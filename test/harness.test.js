// The measurement harness: connection reuse (new sockets are counted and kept open), the mode order of each block,
// interval estimates over processes or blocks, and argument errors. Local servers only; nothing contacts a network.
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { expect } = require('chai');
const { ethers } = require('ethers');
const R = require('../scripts/lib/rpc');
const M = require('../scripts/lib/sepolia-modes');
const S = require('../scripts/lib/stats');
const { analyzeLocal, analyzeSepolia } = require('../scripts/analyze-latency');

const ROOT = path.join(__dirname, '..');
const ABI = require(path.join(ROOT, 'artifacts', 'contracts', 'DIDRegistry.sol', 'DIDRegistry.json')).abi;
const ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const CREDENTIAL = {
  id: 'urn:uuid:00000000-0000-4000-8000-000000000000',
  issuer: 'did:smid:issuer-harness',
  credentialSubject: { id: 'did:smid:subject-harness' },
};

// Answers like a registry that holds both DIDs, the issuer document and no revocation.
function registryServer() {
  const iface = new ethers.utils.Interface(ABI);
  const answer = (request) => {
    if (request.method === 'eth_blockNumber') return '0x10';
    if (request.method === 'eth_chainId') return '0x539';
    const call = iface.parseTransaction({ data: request.params[0].data });
    if (call.name === 'verifyDID') return iface.encodeFunctionResult('verifyDID', [true]);
    if (call.name === 'isCredentialRevoked') return iface.encodeFunctionResult('isCredentialRevoked', [false]);
    return iface.encodeFunctionResult('getDIDDocument', [[CREDENTIAL.issuer, ADDRESS, ['k'], ['k'], [], 1, 1, true,
      ethers.constants.HashZero, 0]]);
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const out = Array.isArray(parsed)
        ? parsed.map((r) => ({ jsonrpc: '2.0', id: r.id, result: answer(r) }))
        : { jsonrpc: '2.0', id: parsed.id, result: answer(parsed) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, url: `http://127.0.0.1:${server.address().port}/`,
  })));
}

function runScript(script, args, env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT, timeout: 60000, env: { ...process.env, ...env },
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr, ms: Date.now() - started }));
  });
}

describe('harness: connections, mode order, intervals and arguments', function () {
  this.timeout(60000);

  describe('connections', function () {
    let sockets;
    let srv;
    beforeEach(async function () {
      sockets = R.installAgents();
      srv = await registryServer();
    });
    afterEach(function () {
      sockets.restore();
      srv.server.close();
    });

    it('installs keep-alive agents with first-in-first-out reuse and a long idle timeout', function () {
      for (const agent of [http.globalAgent, require('https').globalAgent]) {
        expect(agent.keepAlive).to.equal(true);
        expect(agent.options.scheduling).to.equal('fifo');
        expect(agent.options.timeout).to.be.at.least(600000);
      }
    });

    it('counts new sockets and reuses all of them afterwards, also those opened by concurrent requests', async function () {
      const provider = R.makeProvider(srv.url, { network: { name: 'local', chainId: 1337 } });
      await provider.send('eth_blockNumber', []);
      expect(sockets.newSockets).to.equal(1);
      await Promise.all([1, 2, 3, 4].map(() => provider.send('eth_blockNumber', [])));
      const afterConcurrent = sockets.newSockets;
      expect(afterConcurrent).to.be.within(1, 4);
      for (let i = 0; i < 8; i++) await provider.send('eth_blockNumber', []);
      await Promise.all([1, 2, 3, 4].map(() => provider.send('eth_blockNumber', [])));
      expect(sockets.newSockets).to.equal(Math.max(afterConcurrent, 4));
    });

    it('records the new sockets opened inside the timer on every measured row', async function () {
      const provider = R.makeProvider(srv.url, { network: { name: 'local', chainId: 1337 } });
      const iface = new ethers.utils.Interface(ABI);
      const ctx = { provider, counter: R.requestCounter(provider), sockets, credential: CREDENTIAL, iface, address: ADDRESS,
        blockLag: 0, calls: M.readCalls(iface, ADDRESS, CREDENTIAL) };
      const first = await M.runMode('C', ctx);
      expect(first.sane).to.equal(true);
      expect(first.newSocketsDuringTimer).to.be.a('number');
      for (const mode of ['S', 'C', 'Bt']) {
        const row = await M.runMode(mode, ctx);
        expect(row.newSocketsDuringTimer, mode).to.equal(0);
      }
    });
  });

  describe('error codes', function () {
    // Answers the block number; fails every contract read (single or batched) in one of three ways.
    function failingServer(behaviour) {
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          if (!Array.isArray(parsed) && parsed.method === 'eth_blockNumber') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: '0x10' }));
          } else if (behaviour === 'block') {
            const err = (id) => ({ jsonrpc: '2.0', id, error: { code: -32000, message: 'header not found' } });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map((r) => err(r.id)) : err(parsed.id)));
          } else {
            res.writeHead(Number(behaviour), { 'Content-Type': 'text/plain' });
            res.end('failure');
          }
        });
      });
      return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        server, url: `http://127.0.0.1:${server.address().port}/`,
      })));
    }

    for (const [behaviour, must, mustNot] of [['block', 'BLOCK_UNAVAILABLE', 'HTTP_'], ['429', 'HTTP_429', 'BLOCK_UNAVAILABLE'],
      ['500', 'HTTP_500', 'BLOCK_UNAVAILABLE']]) {
      it(`names a ${behaviour} failure in every mode, with codes only`, async function () {
        const { server, url } = await failingServer(behaviour);
        try {
          const { CredentialVerifierService } = require('../src/vc/verifier-service');
          const provider = R.makeProvider(url, { network: { name: 'local', chainId: 1337 }, timeoutMs: 2000 });
          const iface = new ethers.utils.Interface(ABI);
          const contract = new ethers.Contract(ADDRESS, ABI, provider);
          const ctx = { provider, counter: R.requestCounter(provider), credential: { '@context': ['https://www.w3.org/ns/credentials/v2', 'https://w3id.org/security/data-integrity/v2'],
              type: ['VerifiableCredential'], ...CREDENTIAL, proof: { verificationMethod: `${CREDENTIAL.issuer}#key-1` } }, iface,
            address: ADDRESS, blockLag: 0, calls: M.readCalls(iface, ADDRESS, CREDENTIAL),
            verifier: new CredentialVerifierService(contract, { provider }) };
          for (const mode of ['P', 'S', 'C', 'Bt']) {
            const row = await M.runMode(mode, ctx);
            const code = row.error;
            expect(code, `${mode}: ${code}`).to.include(must);
            expect(code, `${mode}: ${code}`).to.not.include(mustNot);
            expect(code, mode).to.match(/^[A-Z0-9_/-]+$/);
          }
        } finally {
          server.close();
        }
      });
    }

    it('turns nested JSON-RPC numbers and HTTP statuses into RPC_<n> and HTTP_<n>', function () {
      expect(R.errorCode({ code: -32000 })).to.equal('RPC_-32000');
      expect(R.errorCode({ status: 429 })).to.equal('HTTP_429');
      expect(R.errorCode({ code: 'SERVER_ERROR', error: { code: -32000, message: 'header not found' } }))
        .to.equal('SERVER_ERROR/RPC_-32000/BLOCK_UNAVAILABLE');
      expect(R.errorCode({ code: 'SERVER_ERROR', status: 429, body: 'see https://x.example/v3/TOKEN' })).to.equal('SERVER_ERROR/HTTP_429');
      expect(R.errorCode(new Error('x'))).to.equal('UNKNOWN_ERROR');
    });
  });

  describe('mode order', function () {
    it('uses each order 25 times over ten blocks, and gives a block run alone the same orders as in the full run', function () {
      const counts = {};
      const full = {};
      for (let block = 1; block <= 10; block++) {
        for (let i = 0; i < 10; i++) {
          const order = M.orderFor({ block, index: i, perBlock: 10 }).join(',');
          counts[order] = (counts[order] || 0) + 1;
          full[`${block}:${i}`] = order;
        }
      }
      expect(Object.values(counts)).to.deep.equal([25, 25, 25, 25]);
      for (let i = 0; i < 10; i++) expect(M.orderFor({ block: 7, index: i, perBlock: 10 }).join(',')).to.equal(full[`7:${i}`]);
    });
  });

  describe('intervals over clusters', function () {
    it('gives an order-statistic interval of the cluster medians with its exact coverage', function () {
      const five = S.clusterMedianCI([5, 1, 4, 2, 3]);
      expect([five.lower, five.upper, five.ranks]).to.deep.equal([1, 5, [1, 5]]);
      expect(five.coverage).to.equal(0.9375);
      const ten = S.clusterMedianCI([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
      expect([ten.lower, ten.upper, ten.ranks]).to.deep.equal([2, 9, [2, 9]]);
      expect(ten.coverage).to.be.closeTo(1 - 2 * 11 / 1024, 1e-12);
      expect(() => S.clusterMedianCI([])).to.throw();
    });

    it('reports per-process medians, an interval over processes, drift between halves and header mismatches', function () {
      const rows = [
        { kind: 'header', processIndex: 1, commit: 'abc', cpu: 'x', node: 'v22', hardhat: '2.29.0', hardfork: 'osaka' },
        { kind: 'header', processIndex: 2, commit: 'def', cpu: 'x', node: 'v22', hardhat: '2.29.0', hardfork: 'osaka' },
        { kind: 'header', processIndex: 2, commit: 'def', cpu: 'x', node: 'v22', hardhat: '2.29.0', hardfork: 'osaka' },
      ];
      for (const [p, base] of [[1, 3], [2, 5]]) {
        for (let i = 1; i <= 20; i++) {
          rows.push({ kind: 'local', process: p, iteration: 100 + i, warmup: false, valid: true, total_ms: base + (i <= 10 ? 1 : 0) });
        }
      }
      const { out } = analyzeLocal(rows);
      expect(out.clusters.k).to.equal(2);
      expect(out.clusters.medians).to.deep.equal({ 1: 3.5, 2: 5.5 });
      expect([out.clusters.interval.lower, out.clusters.interval.upper]).to.deep.equal([3.5, 5.5]);
      expect(out.clusters.medianOfMedians).to.equal(4.5);
      expect(out.drift.firstHalfMedian).to.be.above(out.drift.secondHalfMedian);
      expect(out.drift.clustersSlowerFirst).to.equal(2);
      expect(out.warnings.join(' ')).to.match(/commit/);
      expect(out.warnings.join(' ')).to.match(/process index 2/);
    });

    it('pairs Sepolia rows within one run and block, reports new sockets by mode and order, and gives block intervals', function () {
      const rows = [];
      const add = (run, block, reserve) => {
        for (let i = 1; i <= 10; i++) {
          const common = { kind: 'sepolia', run, block, iteration: i, warmup: false, pilot: false, ...(reserve ? { reserve } : {}),
            order: 'P,S,C,Bt', chainIdDuringTimer: 0, newSocketsDuringTimer: 0 };
          rows.push({ ...common, mode: 'S', total_ms: 600 + block, sane: true, requests: { eth_blockNumber: 1, eth_call: 4 } });
          rows.push({ ...common, mode: 'C', total_ms: 200, sane: true, requests: { eth_blockNumber: 1, eth_call: 4 },
            ...(i === 1 ? { newSocketsDuringTimer: 3 } : {}) });
        }
      };
      add('2026-11-11T02:30:00.000Z', 1);
      add('2026-11-11T02:30:00.000Z', 2);
      add('2026-11-11T15:10:00.000Z', 2, true);
      const { out } = analyzeSepolia(rows);
      expect(out.speedup_S_over_C.n).to.equal(30);
      expect(out.newSockets).to.deep.equal({ C: { 'P,S,C,Bt': 3 } });
      expect(out.clusters.S.k).to.equal(3);
      expect(out.clusters.S.interval.ranks).to.deep.equal([1, 3]);
      expect(out.speedup_S_over_C.blockInterval.clusters).to.equal(3);
      expect(Object.keys(out.perBlockMedian)).to.have.length(3);
    });
  });

  describe('arguments and exit', function () {
    const env = { SEPOLIA_RPC_URL: 'http://127.0.0.1:9/never' };
    it('names a missing --log and an invalid --block-lag or --timeout-ms', async function () {
      const deployment = path.join(ROOT, 'package.json');
      let r = await runScript('measure-sepolia.js', ['--deployment', deployment], env);
      expect(r.stderr).to.match(/ARG_LOG_MISSING/);
      r = await runScript('measure-sepolia.js', ['--deployment', deployment, '--log', 'x.jsonl', '--block-lag', 'abc'], env);
      expect(r.stderr).to.match(/ARG_BLOCK_LAG/);
      r = await runScript('measure-sepolia.js', ['--deployment', deployment, '--log', 'x.jsonl', '--timeout-ms', '-1'], env);
      expect(r.stderr).to.match(/ARG_TIMEOUT/);
      for (const k of ['0', '11', 'x', '2.5']) {
        r = await runScript('measure-sepolia.js', ['--deployment', deployment, '--log', 'x.jsonl', '--only-block', k], env);
        expect(r.stderr, k).to.match(/ARG_ONLY_BLOCK/);
      }
      r = await runScript('measure-sepolia.js', ['--deployment', deployment, '--log', 'x.jsonl', '--only-block', '3', '--at', '25:00'], env);
      expect(r.stderr).to.match(/ARG_AT/);
    });
  });
});
