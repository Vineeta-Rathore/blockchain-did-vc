// DID documents shared by measure-gas.js and deploy-sepolia.js, so that local and Sepolia gas are measured on
// documents of the same shape. Calldata gas depends on the input bytes: the hex and base58 strings used here contain
// no zero bytes, so documents of the same lengths cost the same, except for zero bytes in dataHash (a zero calldata
// byte costs 12 gas less than a non-zero one). measure-gas.js can therefore replay a deployment's exact inputs.
const crypto = require('crypto');
const { ethers } = require('ethers');
const { VerifiableCredentialService, base58btc, canonicalize } = require('../../src/vc/vc-service');

const ISSUER_SERVICE_ENDPOINT = 'https://issuer.example/credentials';

function randomDidId() {
  return `did:smid:${crypto.randomBytes(16).toString('hex')}`;
}

// Deterministic DID and public key for repeatable local gas figures. Only the public key is derived and returned.
function seededDidId(label) {
  return `did:smid:${crypto.createHash('sha256').update(`smid-gas-did:${label}`).digest('hex').slice(0, 32)}`;
}

function seededPublicKeyMultibase(label) {
  const seed = crypto.createHash('sha256').update(`smid-gas-key:${label}`).digest();
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const raw = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).slice(-32);
  return `z${base58btc(Buffer.concat([Buffer.from([0xed, 0x01]), raw]))}`;
}

// Inputs for createDID: one Ed25519 Multikey verification method; the issuer also lists one service.
function didDocumentInputs({ didId, publicKeyMultibase, withService }) {
  const verificationMethod = VerifiableCredentialService.createVerificationMethod(didId, publicKeyMultibase);
  const service = withService
    ? { id: `${didId}#credentials`, type: 'CredentialIssuerService', serviceEndpoint: ISSUER_SERVICE_ENDPOINT }
    : null;
  const document = { id: didId, verificationMethod: [verificationMethod], service: service ? [service] : [] };
  return {
    didId,
    verificationMethods: [JSON.stringify(verificationMethod)],
    services: service ? [JSON.stringify(service)] : [],
    dataHash: ethers.utils.keccak256(ethers.utils.toUtf8Bytes(canonicalize(document))),
  };
}

// The seeded inputs of scripts/measure-gas.js (case 1) and test/GasSchedule.test.js.
function seededGasInputs() {
  const issuerDid = seededDidId('issuer');
  const subjectDid = seededDidId('subject');
  return {
    issuer: didDocumentInputs({ didId: issuerDid, publicKeyMultibase: seededPublicKeyMultibase('issuer'), withService: true }),
    subject: didDocumentInputs({ didId: subjectDid, publicKeyMultibase: seededPublicKeyMultibase('subject'), withService: false }),
    credentialId: 'urn:uuid:5f0c2b9e-8d47-4c3a-9b61-2e7d4a8f1c03',
    reasonCode: 9,
  };
}

function randomCredentialId() {
  return `urn:uuid:${crypto.randomUUID()}`;
}

module.exports = {
  didDocumentInputs,
  randomCredentialId,
  randomDidId,
  seededDidId,
  seededGasInputs,
  seededPublicKeyMultibase,
};
