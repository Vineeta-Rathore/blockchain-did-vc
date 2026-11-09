// What the Sepolia scripts treat as a secret (scripts/lib/rpc.js). Fake URLs only; nothing here contacts a network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');
const R = require('../scripts/lib/rpc');

const KEY = 'FAKEKEYFAKEKEY123';

describe('RPC helpers: what counts as a secret', function () {
  it('keeps ordinary words of a URL, so rows and records keep their own fields', function () {
    const urls = [
      'https://1rpc.io/sepolia',
      `https://lb.drpc.org/ogrpc?network=sepolia&dkey=${KEY}`,
      `https://site1.moralis-nodes.com/sepolia/${KEY}`,
      'https://ethereum-sepolia-rpc.publicnode.com',
    ];
    for (const url of urls) {
      const row = JSON.stringify({ kind: 'sepolia', script: 'measure-sepolia.js', network: 'sepolia' });
      expect(R.makeRedactor(url)(row), url).to.equal(row);
      expect(R.scanText('{"network": "sepolia"}', [...R.secretParts(url)]), url).to.deep.equal([]);
    }
  });

  it('removes tokens in the path, the query and the host name', function () {
    const cases = [
      [`https://eth-sepolia.g.alchemy.com/v2/${KEY}`, KEY],
      [`https://lb.drpc.org/ogrpc?network=sepolia&dkey=${KEY}`, KEY],
      ['https://abc123def456ghi789.sepolia.example.pro/', 'abc123def456ghi789'],
      ['https://rpc.example.org/?apikey=lettersonlysecret', 'lettersonlysecret'],
    ];
    for (const [url, token] of cases) {
      const out = R.makeRedactor(url)(`failed at ${url}; the token alone: ${token}`);
      expect(out, url).to.not.include(token);
    }
  });

  it('removes user information from any URL', function () {
    const out = R.makeRedactor('https://rpc.example.org/')('see https://alice:longsecretpw@other.example.org/x');
    expect(out).to.not.include('longsecretpw');
    expect(out).to.not.include('alice');
    expect(out).to.include('https://other.example.org/[redacted]');
  });

  it('matches a hex key in either case, with or without 0x', function () {
    const key = `0x${'ab12'.repeat(16)}`;
    const redact = R.makeRedactor('https://rpc.example.org/', [key]);
    expect(redact(`x ${key.toUpperCase()} y`)).to.not.include(key.slice(2).toUpperCase());
    expect(R.scanText(`x ${key.slice(2).toUpperCase()} y`, [key])).to.not.deep.equal([]);
  });

  it('reads only the URL from the env line, without quotes or an inline comment', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-env-'));
    const file = path.join(dir, 'test.env');
    fs.writeFileSync(file, `OTHER=1\nSEPOLIA_RPC_URL="https://eth-sepolia.g.alchemy.com/v2/${KEY}" # my key\n`);
    const saved = process.env.SEPOLIA_RPC_URL;
    delete process.env.SEPOLIA_RPC_URL;
    try {
      expect(R.readRpcUrl(file)).to.equal(`https://eth-sepolia.g.alchemy.com/v2/${KEY}`);
    } finally {
      if (saved !== undefined) process.env.SEPOLIA_RPC_URL = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a self-scan hit with its code', function () {
    const write = R.makeWriter((t) => t, () => {});
    let error;
    try {
      write('{"secretKeyMultibase":"x"}');
    } catch (e) {
      error = e;
    }
    expect(R.errorCode(error)).to.equal('SELF_SCAN_FAILED');
  });
});
