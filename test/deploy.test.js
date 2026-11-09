// scripts/deploy-sepolia.js against a Hardhat node started for these tests (chain 1337, its own port): a fresh run,
// re-runs of a completed record, refusals, and the paths a run takes after it was interrupted (a transaction dropped
// before it was mined, a replacement, a nonce used by another transaction). Mining is paused and resumed through the
// node's own methods (evm_setAutomine, hardhat_dropTransaction). Nothing contacts any other network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { expect } = require('chai');
const { ethers } = require('ethers');

const ROOT = path.join(__dirname, '..');
const MNEMONIC = 'test test test test test test test test test test test junk'; // Hardhat's public test accounts
const account = (i) => ethers.Wallet.fromMnemonic(MNEMONIC, `m/44'/60'/0'/0/${i}`);

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

describe('deploy-sepolia.js: fresh runs, re-runs and interrupted runs (local Hardhat node)', function () {
  this.timeout(300000);
  let node;
  let url;
  let rpc;
  let dir;
  let next = 10; // Hardhat accounts 10-19: one fresh deployer per test

  before(async function () {
    const port = await freePort();
    url = `http://127.0.0.1:${port}/`;
    node = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'hardhat', 'internal', 'cli', 'bootstrap.js'), 'node',
      '--hostname', '127.0.0.1', '--port', String(port)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
    // The node must not outlive the test run (a running node locks files in node_modules).
    process.on('exit', () => node.kill());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('node did not start')), 120000);
      let seen = '';
      node.stdout.on('data', (d) => {
        seen = (seen + String(d)).slice(-4096);
        if (seen.includes('Started HTTP')) { clearTimeout(timer); resolve(); }
      });
      node.on('exit', () => reject(new Error('node exited')));
    });
    rpc = new ethers.providers.StaticJsonRpcProvider(url, { name: 'local', chainId: 1337 });
  });
  after(function () {
    if (node) node.kill();
  });
  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
    await rpc.send('evm_setAutomine', [true]);
  });
  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const wallet = account(next++);
    const keyFile = path.join(dir, 'key.json');
    fs.writeFileSync(keyFile, JSON.stringify({ address: wallet.address, privateKey: wallet.privateKey }));
    const out = path.join(dir, 'record.json');
    const run = (...extra) => new Promise((resolve) => {
      const defaults = extra.includes('--max-base-fee-gwei') ? [] : ['--max-base-fee-gwei', '50'];
      execFile(process.execPath, [path.join(ROOT, 'scripts', 'deploy-sepolia.js'), '--key', keyFile, '--out', out,
        '--secrets-dir', path.join(dir, 'secrets'), '--expect-chain', '1337', ...defaults, ...extra],
      { cwd: ROOT, timeout: 240000, env: { ...process.env, SEPOLIA_RPC_URL: url } },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    });
    const record = () => JSON.parse(fs.readFileSync(out, 'utf8'));
    return { wallet: wallet.connect(rpc), out, run, record };
  }
  const STEPS = ['deploy', 'createIssuerDID', 'createSubjectDID', 'revokeCredentialA'];

  it('completes a fresh run, and leaves a completed record and the chain untouched on a re-run', async function () {
    const { wallet, out, run, record } = setup();
    const r = await run();
    expect(r.code, r.stderr).to.equal(0);
    const rec = record();
    expect(rec.completedAt).to.be.a('string');
    expect(Object.keys(rec.txs)).to.deep.equal(STEPS);
    expect(rec.bytecode.equal).to.equal(true);
    expect(rec.pending).to.deep.equal({});
    const text = fs.readFileSync(out, 'utf8');
    const nonce = await wallet.getTransactionCount();
    const again = await run();
    expect(again.code).to.equal(0);
    expect(again.stdout).to.include('setup already complete');
    expect(fs.readFileSync(out, 'utf8')).to.equal(text);
    expect(await wallet.getTransactionCount()).to.equal(nonce);
  });

  it('refuses a locked record, a record of another deployer, and a record that the chain contradicts', async function () {
    const { out, run, record } = setup();
    fs.writeFileSync(`${out}.lock`, '');
    let r = await run();
    expect(r.stderr).to.include('RECORD_LOCKED');
    expect(fs.existsSync(out)).to.equal(false);
    fs.unlinkSync(`${out}.lock`);

    expect((await run()).code).to.equal(0);
    const rec = record();
    fs.writeFileSync(out, JSON.stringify({ ...rec, deployer: account(1).address }));
    r = await run();
    expect(r.stderr).to.include('DEPLOYER_MISMATCH');

    const { completedAt, ...open } = rec;
    fs.writeFileSync(out, JSON.stringify({ ...open, address: ethers.Wallet.createRandom().address }));
    r = await run();
    expect(r.stderr).to.include('RECORD_AND_CHAIN_DISAGREE');
  });

  it('after a transaction was dropped before it was mined, broadcasts the saved transaction again and completes', async function () {
    const { wallet, run, record } = setup();
    await rpc.send('evm_setAutomine', [false]);
    let r = await run('--wait-timeout-s', '1');
    expect(r.stderr).to.include('TX_PENDING_TIMEOUT');
    const pending = record().pending.deploy;
    expect(pending.hashes).to.have.length(1);
    await rpc.send('hardhat_dropTransaction', [pending.hashes[0]]);
    await rpc.send('evm_setAutomine', [true]);
    r = await run();
    expect(r.code, r.stderr).to.equal(0);
    const rec = record();
    expect(rec.txs.deploy.hash).to.equal(pending.hashes[0]);
    expect(rec.txs.deploy.nonce).to.equal(pending.nonce);
    expect(await wallet.getTransactionCount()).to.equal(pending.nonce + 4);
  });

  it('with --resend, replaces a stuck transaction at higher fees and records the one that was mined', async function () {
    const { wallet, run, record } = setup();
    await rpc.send('evm_setAutomine', [false]);
    let r = await run('--wait-timeout-s', '1');
    expect(r.stderr).to.include('TX_PENDING_TIMEOUT');
    r = await run('--resend', '--wait-timeout-s', '1');
    expect(r.stderr, 'the replacement is accepted by the node').to.include('TX_PENDING_TIMEOUT');
    const pending = record().pending.deploy;
    expect(pending.hashes).to.have.length(2);
    await rpc.send('evm_setAutomine', [true]);
    await rpc.send('evm_mine', []);
    r = await run();
    expect(r.code, r.stderr).to.equal(0);
    const rec = record();
    expect(rec.txs.deploy.hash).to.equal(pending.hashes[1]);
    expect(await wallet.getTransactionCount()).to.equal(pending.nonce + 4);
  });

  it('after a stop before signing (base fee too high), completes on a plain re-run', async function () {
    const { wallet, run, record } = setup();
    let r = await run('--max-base-fee-gwei', '0.000000001');
    expect(r.stderr).to.include('BASE_FEE_TOO_HIGH');
    expect(record().pending.deploy.hashes).to.deep.equal([]);
    r = await run('--wait-timeout-s', '30');
    expect(r.code, r.stderr).to.equal(0);
    expect(r.stdout).to.not.include('undefined');
    expect(Object.keys(record().txs)).to.deep.equal(STEPS);
    expect(await wallet.getTransactionCount()).to.equal(4);
  });

  it('refuses invalid numbers for the wait timeout and the fees', async function () {
    const { run } = setup();
    for (const [args, code] of [[['--wait-timeout-s', 'abc'], 'ARG_WAIT_TIMEOUT'], [['--wait-timeout-s', '0'], 'ARG_WAIT_TIMEOUT'],
      [['--wait-timeout-s', '--resend'], 'ARG_WAIT_TIMEOUT'], [['--tip-gwei', 'x'], 'ARG_TIP'],
      [['--max-base-fee-gwei', '-1'], 'ARG_MAX_BASE_FEE']]) {
      const r = await run(...args);
      expect(r.stderr, args.join(' ')).to.include(code);
    }
  });

  it('refuses a replacement whose fee would exceed the policy ceiling (2 x maximum base fee + tip)', async function () {
    const { run, record } = setup();
    await rpc.send('evm_setAutomine', [false]);
    const base = (await rpc.getBlock('latest')).baseFeePerGas;
    const maxBase = ethers.utils.formatUnits(base.mul(105).div(100).add(1), 'gwei');
    let r = await run('--max-base-fee-gwei', maxBase, '--wait-timeout-s', '1');
    expect(r.stderr).to.include('TX_PENDING_TIMEOUT');
    r = await run('--max-base-fee-gwei', maxBase, '--resend', '--wait-timeout-s', '1');
    expect(r.stderr).to.include('FEE_CAP_REACHED');
    expect(record().pending.deploy.hashes).to.have.length(1);
    await rpc.send('evm_setAutomine', [true]);
    await rpc.send('evm_mine', []);
  });

  it('stops when the saved nonce was used by a transaction it did not send', async function () {
    const { wallet, run, record } = setup();
    await rpc.send('evm_setAutomine', [false]);
    let r = await run('--wait-timeout-s', '1');
    expect(r.stderr).to.include('TX_PENDING_TIMEOUT');
    const pending = record().pending.deploy;
    await rpc.send('hardhat_dropTransaction', [pending.hashes[0]]);
    await rpc.send('evm_setAutomine', [true]);
    await (await wallet.sendTransaction({ to: wallet.address, value: 1, nonce: pending.nonce })).wait();
    r = await run('--wait-timeout-s', '1');
    expect(r.stderr).to.include('NONCE_USED_ELSEWHERE');
    expect(record().txs.deploy).to.equal(undefined);
  });
});
