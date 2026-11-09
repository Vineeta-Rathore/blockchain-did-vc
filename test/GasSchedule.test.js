const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { seededGasInputs } = require('../scripts/lib/fixtures');
const { GLAMSTERDAM, OSAKA, glamsterdamGas, storageWrites } = require('../scripts/lib/gas-schedule');

// Gas of the seeded inputs of scripts/measure-gas.js (case 1): on the Hardhat network (osaka), and on Sepolia as
// reported by eth_simulateV1 on 9 Nov 2026 (base block 12095213, sender 0x1Af22bC52FB82C57Fb210536462D6b857A3C073f,
// registry code placed by a state override for the three calls). The model in scripts/lib/gas-schedule.js must give
// the Sepolia values from the local storage writes.
const OSAKA_GAS = { deploy: 2999747, createIssuer: 662928, createSubject: 489098, revoke: 56765 };
const SEPOLIA_2026_11_09 = { deploy: 21194807, createIssuer: 3119488, createSubject: 2249198, revoke: 138785 };
const NEW_SLOTS = { deploy: 2, createIssuer: 28, createSubject: 20, revoke: 1 };

const measured = {};

// The figures in the README tables are typed by hand; this checks them against the measurement above.
const ROWS = {
  deploy: 'Deployment',
  createIssuer: "`createDID`, a controller's first DID",
  createSubject: "`createDID`, a controller's second DID",
  revoke: '`revokeCredential`',
};
const firstNumber = (cell) => {
  const m = cell.match(/\d{1,3}(?:,\d{3})+|\d+/);
  return m ? Number(m[0].replace(/,/g, '')) : null;
};
function readDoc(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}
function row(text, file, label) {
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith(`| ${label}`));
  expect(lines, `${file}: one row "${label}"`).to.have.length(1);
  return lines[0].split('|').slice(1, -1).map((c) => c.trim());
}

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
  });

  it('prices one new storage slot at 64 bytes of state and returns null for writes it does not model', function () {
    const none = { setCold: 0, setWarm: 0, resetCold: 0, resetWarm: 0, noopCold: 0, noopWarm: 0, unmodelled: 0 };
    expect(GLAMSTERDAM.setCold - OSAKA.setCold).to.equal(64 * 1530 + 10000 - 20000);
    expect(glamsterdamGas({ gasUsed: 100000, writes: { ...none, setCold: 1 } })).to.equal(100000 + 87920 - 6000);
    expect(glamsterdamGas({ gasUsed: 100000, writes: { ...none, unmodelled: 1 } })).to.equal(null);
  });

  it('matches the gas tables of README.md and results/README.md', function () {
    expect(Object.keys(measured), 'the first test must run first').to.include.members(Object.keys(ROWS));
    const readme = readDoc('README.md');
    const results = readDoc('results/README.md');
    for (const [name, label] of Object.entries(ROWS)) {
      const m = measured[name];
      const a = row(readme, 'README.md', label);
      expect([firstNumber(a[1]), firstNumber(a[2]), firstNumber(a[3])], `README.md ${name}`).to.deep.equal([m.osaka, m.sepolia, m.slots]);
      const b = row(results, 'results/README.md', label);
      expect([firstNumber(b[1]), firstNumber(b[2])], `results/README.md ${name}`).to.deep.equal([m.osaka, m.sepolia]);
    }
    expect(firstNumber(row(readme, 'README.md', ROWS.deploy)[0]), 'README.md code bytes').to.equal(measured.codeBytes);
    const slots = results.match(/create (\d+), (\d+), (\d+) and (\d+) new storage slots/);
    expect(slots && slots.slice(1).map(Number), 'results/README.md slot sentence')
      .to.deep.equal(Object.keys(ROWS).map((k) => measured[k].slots));
    const code = results.match(/its ([\d,]+) bytes of code/);
    expect(code && Number(code[1].replace(/,/g, '')), 'results/README.md code bytes').to.equal(measured.codeBytes);
  });
});
