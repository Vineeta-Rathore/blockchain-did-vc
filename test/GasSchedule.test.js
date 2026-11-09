const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { seededGasInputs } = require('../scripts/lib/fixtures');
const { GLAMSTERDAM, OSAKA, glamsterdamGas, storageWrites } = require('../scripts/lib/gas-schedule');

// Gas of the seeded inputs of scripts/measure-gas.js (case 1): on the Hardhat network (osaka), and on Sepolia as
// reported by eth_simulateV1 on 9 Nov 2026 (base block 12098173, sender 0x1Af22bC52FB82C57Fb210536462D6b857A3C073f,
// registry code placed by a state override for the three calls). The model in scripts/lib/gas-schedule.js must give
// the Sepolia values from the local storage writes.
const OSAKA_GAS = { deploy: 3069348, createIssuer: 640821, createSubject: 466991, revoke: 56791 };
const SEPOLIA_2026_11_09 = { deploy: 21692728, createIssuer: 3009361, createSubject: 2139071, revoke: 138811 };
const SEPOLIA_BASE_BLOCK = 12098173;
const NEW_SLOTS = { deploy: 2, createIssuer: 27, createSubject: 19, revoke: 1 };

const measured = {};

// The figures in the READMEs and the CHANGELOG are typed by hand; the last test checks them against the measurement.
const ROWS = {
  deploy: 'Deployment',
  createIssuer: "`createDID`, a controller's first DID",
  createSubject: "`createDID`, a controller's second DID",
  revoke: '`revokeCredential`',
};
const fmt = (n) => n.toLocaleString('en-GB');
const readDoc = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function row(text, file, label) {
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith(`| ${label}`));
  expect(lines, `${file}: one row "${label}"`).to.have.length(1);
  return lines[0].split('|').slice(1, -1).map((c) => c.trim());
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A cell that holds exactly the number, optionally followed by a note in brackets.
const numberCell = (n) => new RegExp(`^${escape(fmt(n))}( \\([^)]*\\))?$`);

describe('Gas schedule (osaka on Hardhat, Glamsterdam on Sepolia)', function () {
  it('reproduces the Sepolia gas of all four operations from the local storage writes', async function () {
    const { issuer, subject, credentialId, reasonCode } = seededGasInputs();
    const Factory = await ethers.getContractFactory('DIDRegistry');
    const reg = await Factory.deploy();
    const receipts = { deploy: await reg.deployTransaction.wait() };
    receipts.createIssuer = await (await reg.createDID(issuer.didId, issuer.verificationMethods, issuer.services, issuer.dataHash)).wait();
    receipts.createSubject = await (await reg.createDID(subject.didId, subject.verificationMethods, subject.services, subject.dataHash)).wait();
    receipts.revoke = await (await reg.revokeCredential(issuer.didId, credentialId, reasonCode)).wait();
    const codeBytes = (await ethers.provider.getCode(reg.address)).length / 2 - 1;
    measured.codeBytes = codeBytes;

    for (const [name, receipt] of Object.entries(receipts)) {
      const creation = name === 'deploy';
      const before = creation ? null : ethers.utils.hexValue(receipt.blockNumber - 1);
      const writes = await storageWrites(network.provider, receipt.transactionHash, reg.address, before);
      expect(writes.unmodelled, name).to.equal(0);
      expect(writes.setCold + writes.setWarm, `${name} new slots`).to.equal(NEW_SLOTS[name]);
      expect(receipt.gasUsed.toNumber(), `${name} osaka`).to.equal(OSAKA_GAS[name]);
      const sepolia = glamsterdamGas({ gasUsed: receipt.gasUsed.toNumber(), writes, creation, codeBytes });
      expect(sepolia, `${name} Sepolia`).to.equal(SEPOLIA_2026_11_09[name]);
      measured[name] = { osaka: receipt.gasUsed.toNumber(), sepolia, slots: writes.setCold + writes.setWarm };
    }

    // Case 2 of measure-gas.js: the version 1.0.0 placeholder inputs.
    const reg2 = await Factory.deploy();
    const dh = (s) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(s));
    const gas = async (p) => (await (await p).wait()).gasUsed.toNumber();
    measured.placeholderCreate = await gas(reg2.createDID('did:example:gas-test', ['key1'], ['service1'], dh('gas-test')));
    await gas(reg2.createDID('did:smid:issuer0000', ['key1'], ['service1'], dh('issuer')));
    measured.placeholderRevoke = await gas(reg2.revokeCredential('did:smid:issuer0000', 'urn:uuid:12345678-1234-1234-1234-123456789abc', 9));
  });

  it('prices one new storage slot at 64 bytes of state and returns null for writes it does not model', function () {
    const none = { setCold: 0, setWarm: 0, resetCold: 0, resetWarm: 0, noopCold: 0, noopWarm: 0, unmodelled: 0 };
    expect(GLAMSTERDAM.setCold - OSAKA.setCold).to.equal(64 * 1530 + 10000 - 20000);
    expect(glamsterdamGas({ gasUsed: 100000, writes: { ...none, setCold: 1 } })).to.equal(100000 + 87920 - 6000);
    expect(glamsterdamGas({ gasUsed: 100000, writes: { ...none, unmodelled: 1 } })).to.equal(null);
  });

  it('matches the gas figures of README.md, results/README.md and CHANGELOG.md', function () {
    expect(Object.keys(measured), 'the first test must run first').to.include.members([...Object.keys(ROWS), 'placeholderRevoke']);
    const readme = readDoc('README.md');
    const results = readDoc('results/README.md');
    const changelog = readDoc('CHANGELOG.md');
    for (const [name, label] of Object.entries(ROWS)) {
      const m = measured[name];
      const a = row(readme, 'README.md', label);
      expect(a.slice(1), `README.md ${name}`).to.deep.equal([fmt(m.osaka), fmt(m.sepolia), String(m.slots)]);
      const b = row(results, 'results/README.md', label);
      expect(b[1], `results/README.md ${name} osaka`).to.match(numberCell(m.osaka));
      expect(b[2], `results/README.md ${name} Glamsterdam`).to.equal(fmt(m.sepolia));
    }
    expect(row(readme, 'README.md', ROWS.deploy)[0]).to.equal(`Deployment (${fmt(measured.codeBytes)} bytes of code)`);
    expect(row(results, 'results/README.md', ROWS.createIssuer)[3]).to.equal(fmt(measured.placeholderCreate));
    expect(row(results, 'results/README.md', ROWS.revoke)[3]).to.match(numberCell(measured.placeholderRevoke));
    expect(row(results, 'results/README.md', ROWS.deploy)[3]).to.equal('');
    expect(row(results, 'results/README.md', ROWS.createSubject)[3]).to.equal('');

    const slots = results.match(/create (\d+), (\d+), (\d+) and (\d+) new storage slots/);
    expect(slots && slots.slice(1).map(Number), 'results/README.md slot sentence')
      .to.deep.equal(Object.keys(ROWS).map((k) => measured[k].slots));
    expect(results).to.include(`its ${fmt(measured.codeBytes)} bytes of code`);
    const perSlot = Math.round((GLAMSTERDAM.setCold - OSAKA.setCold) / 1000) * 1000;
    expect(results).to.include(`about ${fmt(perSlot)} gas more`);
    expect(results).to.include(`base block ${fmt(SEPOLIA_BASE_BLOCK)}`);
    for (const n of [measured.deploy.osaka, measured.codeBytes, measured.createIssuer.osaka, measured.createSubject.osaka,
      measured.revoke.osaka]) {
      expect(changelog, `CHANGELOG.md ${fmt(n)}`).to.include(fmt(n));
    }
  });
});
