const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { seededGasInputs } = require('../scripts/lib/fixtures');
const { GLAMSTERDAM, OSAKA, glamsterdamGas, storageWrites } = require('../scripts/lib/gas-schedule');

// Gas of the seeded inputs of scripts/measure-gas.js (case 1): on the Hardhat network (osaka), and on Sepolia as
// reported by eth_simulateV1 on 8 Nov 2026 (base block 12090651, sender 0x1Af22bC52FB82C57Fb210536462D6b857A3C073f,
// registry code placed by a state override). The model in scripts/lib/gas-schedule.js must give the Sepolia values
// from the local storage writes.
const OSAKA_GAS = { deploy: 2838630, createIssuer: 863141, createSubject: 689311, revoke: 145713 };
const SEPOLIA_2026_11_08 = { deploy: 20042702, createIssuer: 4111181, createSubject: 3240891, revoke: 579513 };

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

    for (const [name, receipt] of Object.entries(receipts)) {
      const creation = name === 'deploy';
      const before = creation ? null : ethers.utils.hexValue(receipt.blockNumber - 1);
      const writes = await storageWrites(network.provider, receipt.transactionHash, reg.address, before);
      expect(writes.unmodelled, name).to.equal(0);
      expect(receipt.gasUsed.toNumber(), `${name} osaka`).to.equal(OSAKA_GAS[name]);
      expect(glamsterdamGas({ gasUsed: receipt.gasUsed.toNumber(), writes, creation, codeBytes }), `${name} Sepolia`)
        .to.equal(SEPOLIA_2026_11_08[name]);
    }
  });

  it('prices one new storage slot at 64 bytes of state and returns null for writes it does not model', function () {
    const none = { setCold: 0, setWarm: 0, resetCold: 0, resetWarm: 0, noopCold: 0, noopWarm: 0, unmodelled: 0 };
    expect(GLAMSTERDAM.setCold - OSAKA.setCold).to.equal(64 * 1530 + 10000 - 20000);
    expect(glamsterdamGas({ gasUsed: 100000, writes: { ...none, setCold: 1 } })).to.equal(100000 + 87920 - 6000);
    expect(glamsterdamGas({ gasUsed: 100000, writes: { ...none, unmodelled: 1 } })).to.equal(null);
  });
});
