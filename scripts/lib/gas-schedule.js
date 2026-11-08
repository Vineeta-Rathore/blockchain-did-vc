// Storage writes of a transaction on the Hardhat network, and the gas the same transaction uses under the gas schedule
// that Sepolia has run since its Glamsterdam upgrade (6 Oct 2026), computed from those writes.
//
// Hardhat 2.29 simulates forks up to osaka, so local gas follows the osaka schedule. Three Glamsterdam EIPs change the
// gas of the registry's transactions:
//   EIP-8037 (state creation): 1530 gas per byte of new state (CPSB), charged as state gas: 64 bytes per new storage
//     slot, 120 bytes per new account, 1 byte per byte of deployed code (plus 6 gas per 32-byte word for hashing it).
//   EIP-8038 (state access): STORAGE_WRITE 10000 for every storage write that changes a value; a write that keeps the
//     value pays only the access cost (2100 cold, 100 warm).
//   EIP-2780 (intrinsic gas): 15000 for a call to an existing contract (was 21000), 24000 for a contract creation
//     (was 53000).
// Calldata, cold storage access (2100) and warm access (100) are unchanged for these transactions. With these values,
// glamsterdamGas() reproduced the gas that eth_simulateV1 reported on Sepolia on 8 Nov 2026 exactly, for the
// deployment, both createDID calls and revokeCredential of scripts/measure-gas.js (test/GasSchedule.test.js). The
// EIPs were in Last Call at that date; the deployment record holds the gas actually used.
const { ethers } = require('ethers');

const OSAKA = {
  setCold: 22100, setWarm: 20000, resetCold: 5000, resetWarm: 2900, noopCold: 2200, noopWarm: 100,
  intrinsicCall: 21000, intrinsicCreate: 53000, codeDepositPerByte: 200,
};

const CPSB = 1530;
const STORAGE_WRITE = 10000;
const COLD = 2100;
const WARM = 100;
const GLAMSTERDAM = {
  costPerStateByte: CPSB,
  setCold: COLD + STORAGE_WRITE + 64 * CPSB,
  setWarm: WARM + STORAGE_WRITE + 64 * CPSB,
  resetCold: COLD + STORAGE_WRITE,
  resetWarm: WARM + STORAGE_WRITE,
  noopCold: COLD,
  noopWarm: WARM,
  intrinsicCall: 15000,
  intrinsicCreate: 24000,
  newAccount: 120 * CPSB,
};

const KINDS = ['setCold', 'setWarm', 'resetCold', 'resetWarm', 'noopCold', 'noopWarm'];

// Classifies every SSTORE of the transaction (EIP-2200 terms: original = value at the start of the transaction,
// current = value before this write). Writes that the model does not cover (a dirty slot written again, a slot cleared,
// any call into another contract) are counted under `unmodelled`; glamsterdamGas() then returns null.
async function storageWrites(provider, txHash, address, blockBefore) {
  const trace = await provider.send('debug_traceTransaction', [txHash, { disableMemory: true, disableStorage: true }]);
  const writes = { setCold: 0, setWarm: 0, resetCold: 0, resetWarm: 0, noopCold: 0, noopWarm: 0, unmodelled: 0 };
  const original = new Map();
  const current = new Map();
  const warm = new Set();
  for (const step of trace.structLogs) {
    if (step.depth !== 1) {
      writes.unmodelled += 1;
      continue;
    }
    if (step.op !== 'SLOAD' && step.op !== 'SSTORE') continue;
    const stack = step.stack;
    const slot = ethers.utils.hexZeroPad(`0x${stack[stack.length - 1].replace(/^0x/, '')}`, 32);
    const wasWarm = warm.has(slot);
    warm.add(slot);
    if (!original.has(slot)) {
      const value = blockBefore === null
        ? ethers.constants.Zero
        : ethers.BigNumber.from(await provider.send('eth_getStorageAt', [address, slot, blockBefore]));
      original.set(slot, value);
      current.set(slot, value);
    }
    if (step.op === 'SLOAD') continue;
    const value = ethers.BigNumber.from(`0x${stack[stack.length - 2].replace(/^0x/, '')}`);
    const orig = original.get(slot);
    const cur = current.get(slot);
    let kind;
    if (value.eq(cur)) kind = wasWarm ? 'noopWarm' : 'noopCold';
    else if (!orig.eq(cur) || value.isZero()) kind = 'unmodelled';
    else if (orig.isZero()) kind = wasWarm ? 'setWarm' : 'setCold';
    else kind = wasWarm ? 'resetWarm' : 'resetCold';
    writes[kind] += 1;
    current.set(slot, value);
  }
  return writes;
}

// Gas under the Glamsterdam schedule, from the osaka gas and the storage writes. `codeBytes` only for a creation.
function glamsterdamGas({ gasUsed, writes, creation = false, codeBytes = 0 }) {
  if (writes.unmodelled) return null;
  let delta = 0;
  for (const k of KINDS) delta += writes[k] * (GLAMSTERDAM[k] - OSAKA[k]);
  if (creation) {
    delta += GLAMSTERDAM.intrinsicCreate - OSAKA.intrinsicCreate;
    delta += GLAMSTERDAM.newAccount;
    delta += codeBytes * (CPSB - OSAKA.codeDepositPerByte) + 6 * Math.ceil(codeBytes / 32);
  } else {
    delta += GLAMSTERDAM.intrinsicCall - OSAKA.intrinsicCall;
  }
  return gasUsed + delta;
}

module.exports = { GLAMSTERDAM, OSAKA, glamsterdamGas, storageWrites };
