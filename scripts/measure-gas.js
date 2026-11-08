/**
 * Gas used by the DIDRegistry operations (version 1.1.0), on the Hardhat network with the hardfork pinned in
 * hardhat.config.js.
 *
 * Case 1, realistic documents (the headline figures): each DID document holds one Ed25519 Multikey verification
 *   method, and the issuer's also one service entry, in the same shape that deploy-sepolia.js registers; the
 *   credential ID is a 45-character urn:uuid and the reason code is 9 (privilegeWithdrawn). The issuer DID is the
 *   controller's first DID and the subject DID its second, as in the deployment. Set GAS_INPUTS to a deployment
 *   record (results/sepolia_v1.1_deployment.json) to replay that deployment's exact inputs.
 * Case 2, the R1 placeholder inputs (["key1"], ["service1"]), kept for comparison with the figures of version
 *   1.0.0 (346,878 and 171,188 gas). The issuer DID has the same length as R1's; the free-text reason of R1 is now
 *   reason code 9.
 *
 * Run:  npx hardhat run scripts/measure-gas.js
 *       GAS_INPUTS=results/sepolia_v1.1_deployment.json npx hardhat run scripts/measure-gas.js
 */
const fs = require('fs');
const { ethers, config, network } = require('hardhat');
const { didDocumentInputs, seededDidId, seededPublicKeyMultibase } = require('./lib/fixtures');

const dh = (s) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(s));

function defaultInputs() {
  const issuerDid = seededDidId('issuer');
  const subjectDid = seededDidId('subject');
  return {
    issuer: didDocumentInputs({ didId: issuerDid, publicKeyMultibase: seededPublicKeyMultibase('issuer'), withService: true }),
    subject: didDocumentInputs({ didId: subjectDid, publicKeyMultibase: seededPublicKeyMultibase('subject'), withService: false }),
    credentialId: 'urn:uuid:5f0c2b9e-8d47-4c3a-9b61-2e7d4a8f1c03',
    reasonCode: 9,
  };
}

async function gasOf(txPromise) {
  return (await (await txPromise).wait()).gasUsed.toNumber();
}

async function main() {
  if (network.name !== 'hardhat') {
    throw new Error('measure-gas runs on the Hardhat network only');
  }
  const Factory = await ethers.getContractFactory('DIDRegistry');
  const source = process.env.GAS_INPUTS ? `replayed from ${process.env.GAS_INPUTS}` : 'generated (seeded)';
  const inputs = process.env.GAS_INPUTS
    ? JSON.parse(fs.readFileSync(process.env.GAS_INPUTS, 'utf8')).inputs
    : defaultInputs();
  const { issuer, subject } = inputs;

  // Case 1
  const reg = await Factory.deploy();
  const deployGas = (await reg.deployTransaction.wait()).gasUsed.toNumber();
  const createIssuer = await gasOf(reg.createDID(issuer.didId, issuer.verificationMethods, issuer.services, issuer.dataHash));
  const createSubject = await gasOf(reg.createDID(subject.didId, subject.verificationMethods, subject.services, subject.dataHash));
  const revoke = await gasOf(reg.revokeCredential(issuer.didId, inputs.credentialId, inputs.reasonCode));

  // Case 2
  const reg2 = await Factory.deploy();
  await reg2.deployed();
  const createPlaceholder = await gasOf(reg2.createDID('did:example:gas-test', ['key1'], ['service1'], dh('gas-test')));
  await gasOf(reg2.createDID('did:smid:issuer0000', ['key1'], ['service1'], dh('issuer')));
  const revokePlaceholder = await gasOf(
    reg2.revokeCredential('did:smid:issuer0000', 'urn:uuid:12345678-1234-1234-1234-123456789abc', 9)
  );

  const result = {
    hardfork: config.networks.hardhat.hardfork,
    solc: config.solidity.compilers[0].version,
    optimizerRuns: config.solidity.compilers[0].settings.optimizer.runs,
    case1: {
      inputs: source,
      didLengths: [issuer.didId.length, subject.didId.length],
      verificationMethodLengths: [issuer.verificationMethods[0].length, subject.verificationMethods[0].length],
      serviceLengths: [issuer.services.map((s) => s.length), subject.services.map((s) => s.length)],
      credentialIdLength: inputs.credentialId.length,
      reasonCode: inputs.reasonCode,
      deploy: deployGas,
      createDID_firstOfController: createIssuer,
      createDID_secondOfController: createSubject,
      revokeCredential: revoke,
    },
    case2_r1PlaceholderInputs: {
      createDID_firstOfController: createPlaceholder,
      revokeCredential: revokePlaceholder,
      version_1_0_0: { createDID: 346878, revokeCredential: 171188 },
    },
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  // Hardhat network only (checked above), so the message cannot contain an RPC URL.
  console.error(`measure-gas failed: ${error && error.message}`);
  process.exit(1);
});
