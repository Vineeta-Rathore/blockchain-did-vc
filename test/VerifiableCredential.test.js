const { expect } = require('chai');
const { ethers } = require('hardhat');
const {
  VerifiableCredentialService,
  rawEd25519PublicKeyFromMultibase,
  rawEd25519SecretKeyFromMultibase,
} = require('../src/vc/vc-service');
const { CredentialVerifierService } = require('../src/vc/verifier-service');

describe('DID and VC credential flow', function () {
  let didRegistry;
  let issuer;
  let holder;
  let attacker;
  let issuerDid;
  let holderDid;
  let issuerKeys;
  let holderKeys;
  let issuerVerificationMethod;
  let verifierService;

  beforeEach(async function () {
    [, issuer, holder, attacker] = await ethers.getSigners();

    const DIDRegistry = await ethers.getContractFactory('DIDRegistry');
    didRegistry = await DIDRegistry.deploy();
    await didRegistry.deployed();

    verifierService = new CredentialVerifierService(didRegistry);
    issuerDid = 'did:smid:issuer';
    holderDid = 'did:smid:holder';
    issuerKeys = VerifiableCredentialService.generateEd25519KeyPair();
    holderKeys = VerifiableCredentialService.generateEd25519KeyPair();

    issuerVerificationMethod = VerifiableCredentialService.createVerificationMethod(
      issuerDid,
      issuerKeys.publicKeyMultibase
    );

    const holderVerificationMethod = VerifiableCredentialService.createVerificationMethod(
      holderDid,
      holderKeys.publicKeyMultibase
    );

    await didRegistry.connect(issuer).createDID(
      issuerDid,
      [JSON.stringify(issuerVerificationMethod)],
      ['CredentialIssuerService'],
      ethers.utils.keccak256(ethers.utils.toUtf8Bytes('issuer metadata'))
    );

    await didRegistry.connect(holder).createDID(
      holderDid,
      [JSON.stringify(holderVerificationMethod)],
      ['CredentialHolderService'],
      ethers.utils.keccak256(ethers.utils.toUtf8Bytes('holder metadata'))
    );
  });

  function issueCredential(overrides = {}) {
    return VerifiableCredentialService.issueCredential({
      issuerDid,
      subjectDid: holderDid,
      privateKeyMultibase: issuerKeys.privateKeyMultibase,
      verificationMethod: issuerVerificationMethod,
      registryAddress: didRegistry.address,
      claims: {
        name: 'Verified Identity',
        accessLevel: 'research-lab',
      },
      credentialType: 'IdentityCredential',
      ...overrides,
    });
  }

  it('verifies a valid Ed25519-signed VC successfully', async function () {
    const credential = issueCredential();

    const result = await verifierService.verifyCredential(credential);

    expect(result.valid).to.equal(true);
    expect(result.reason).to.equal('VALID');
    expect(result.issuerDid).to.equal(issuerDid);
    expect(result.subjectDid).to.equal(holderDid);
  });

  it('uses a W3C Ed25519 multikey value with 0xed01 prefix and 32-byte raw key', async function () {
    const rawKey = rawEd25519PublicKeyFromMultibase(issuerKeys.publicKeyMultibase);

    expect(issuerKeys.publicKeyMultibase.startsWith('z')).to.equal(true);
    expect(rawKey.length).to.equal(32);
  });

  it('uses a W3C Ed25519 secret multikey value with 0x8026 prefix and 32-byte raw key', async function () {
    const rawSecretKey = rawEd25519SecretKeyFromMultibase(issuerKeys.secretKeyMultibase);

    expect(issuerKeys.secretKeyMultibase.startsWith('z')).to.equal(true);
    expect(rawSecretKey.length).to.equal(32);
    expect(issuerKeys.privateKeyMultibase).to.equal(issuerKeys.secretKeyMultibase);
  });

  it('fails when the credential subject is tampered', async function () {
    const credential = issueCredential();
    credential.credentialSubject.accessLevel = 'admin';

    const result = await verifierService.verifyCredential(credential);

    expect(result.valid).to.equal(false);
    expect(result.reason).to.equal('INVALID_SIGNATURE');
  });

  it('fails when the issuer DID is tampered', async function () {
    const credential = issueCredential();
    credential.issuer = 'did:smid:unknown-issuer';

    const result = await verifierService.verifyCredential(credential);

    expect(result.valid).to.equal(false);
    expect(result.reason).to.equal('ISSUER_DID_INACTIVE_OR_UNKNOWN');
  });

  it('fails when the credential is signed with the wrong issuer key', async function () {
    const attackerKeys = VerifiableCredentialService.generateEd25519KeyPair();
    const credential = issueCredential({
      privateKeyMultibase: attackerKeys.privateKeyMultibase,
    });

    const result = await verifierService.verifyCredential(credential);

    expect(result.valid).to.equal(false);
    expect(result.reason).to.equal('INVALID_SIGNATURE');
  });

  it('fails when the credential has expired', async function () {
    const credential = issueCredential({
      validFrom: '2024-01-01T00:00:00.000Z',
      validUntil: '2024-01-02T00:00:00.000Z',
    });

    const result = await verifierService.verifyCredential(credential);

    expect(result.valid).to.equal(false);
    expect(result.reason).to.equal('CREDENTIAL_EXPIRED');
  });

  it('fails when the credential is revoked on-chain', async function () {
    const credential = issueCredential();

    const tx = await didRegistry.connect(issuer).revokeCredential(
      issuerDid,
      credential.id,
      9 // RFC 5280 privilegeWithdrawn
    );
    const receipt = await tx.wait();
    console.log(`Gas used for credential revocation: ${receipt.gasUsed.toString()}`);

    const result = await verifierService.verifyCredential(credential);

    expect(result.valid).to.equal(false);
    expect(result.reason).to.equal('CREDENTIAL_REVOKED');
  });

  it('fails when the issuer DID is inactive', async function () {
    const credential = issueCredential();
    await didRegistry.connect(issuer).deactivateDID(issuerDid);

    const result = await verifierService.verifyCredential(credential);

    expect(result.valid).to.equal(false);
    expect(result.reason).to.equal('ISSUER_DID_INACTIVE_OR_UNKNOWN');
  });

  it('fails when the subject DID is inactive', async function () {
    const credential = issueCredential();
    await didRegistry.connect(holder).deactivateDID(holderDid);

    const result = await verifierService.verifyCredential(credential);

    expect(result.valid).to.equal(false);
    expect(result.reason).to.equal('SUBJECT_DID_INACTIVE_OR_UNKNOWN');
  });

  it('documents duplicate credential ID behavior through the revocation registry', async function () {
    const credentialId = 'urn:uuid:duplicate-credential-id';
    const firstCredential = issueCredential({ credentialId });
    const secondCredential = issueCredential({ credentialId });

    expect(firstCredential.id).to.equal(secondCredential.id);

    await didRegistry.connect(issuer).revokeCredential(issuerDid, credentialId, 4);

    const firstResult = await verifierService.verifyCredential(firstCredential);
    const secondResult = await verifierService.verifyCredential(secondCredential);

    expect(firstResult.reason).to.equal('CREDENTIAL_REVOKED');
    expect(secondResult.reason).to.equal('CREDENTIAL_REVOKED');
  });

  it('rejects duplicate revocation attempts', async function () {
    const credential = issueCredential();
    await didRegistry.connect(issuer).revokeCredential(issuerDid, credential.id, 0);

    await expect(
      didRegistry.connect(issuer).revokeCredential(issuerDid, credential.id, 0)
    ).to.be.revertedWith('DIDRegistry: Already revoked');
  });

  it('prevents non-controller credential revocation', async function () {
    const credential = issueCredential();

    await expect(
      didRegistry.connect(attacker).revokeCredential(issuerDid, credential.id, 0)
    ).to.be.revertedWith('DIDRegistry: Not authorized');
  });

  it('fails on a malformed credential missing required fields', async function () {
    const result = await verifierService.verifyCredential({});

    expect(result.valid).to.equal(false);
    expect(result.reason).to.equal('MALFORMED_CREDENTIAL');
  });

  it('fails with MALFORMED_CREDENTIAL when a validly signed credential has no usable id (revocation is keyed by it)', async function () {
    const { proof, id: _issuedId, ...withoutId } = issueCredential();
    const resign = (document) => ({
      ...document,
      proof: VerifiableCredentialService.createProof(document, {
        type: 'DataIntegrityProof',
        cryptosuite: 'eddsa-jcs-2022',
        created: proof.created,
        verificationMethod: proof.verificationMethod,
        proofPurpose: 'assertionMethod',
      }, issuerKeys.privateKeyMultibase),
    });

    for (const credential of [resign(withoutId), resign({ ...withoutId, id: '' })]) {
      const result = await verifierService.verifyCredential(credential);
      expect(result.valid, JSON.stringify(credential.id)).to.equal(false);
      expect(result.reason, JSON.stringify(credential.id)).to.equal('MALFORMED_CREDENTIAL');
    }
  });

  it('fails when the issuer verification method has been rotated off the DID document', async function () {
    const credential = issueCredential();

    // Replace issuer DID's verification methods with a new key under a different key ID.
    // The credential's proof.verificationMethod still references did:smid:issuer#key-1,
    // which is now absent from the DID document, triggering Step V5.
    const newKeys = VerifiableCredentialService.generateEd25519KeyPair();
    const newVerificationMethod = VerifiableCredentialService.createVerificationMethod(
      issuerDid,
      newKeys.publicKeyMultibase,
      'key-2'
    );
    const newDataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('key-rotated'));
    await didRegistry.connect(issuer).updateDID(
      issuerDid,
      [JSON.stringify(newVerificationMethod)],
      ['CredentialIssuerService'],
      newDataHash
    );

    const result = await verifierService.verifyCredential(credential);

    expect(result.valid).to.equal(false);
    expect(result.reason).to.equal('VERIFICATION_METHOD_NOT_FOUND');
  });

  it('fails when the proof configuration is tampered after signing', async function () {
    const credential = issueCredential();

    // Mutate proof.created: this changes the proofConfig hash in the dual-hash pipeline
    // (SHA-256(proofConfig) || SHA-256(document)) without altering the document,
    // so Step V5 passes but Step V6 Ed25519 verification fails.
    credential.proof.created = '2000-01-01T00:00:00.000Z';

    const result = await verifierService.verifyCredential(credential);

    expect(result.valid).to.equal(false);
    expect(result.reason).to.equal('INVALID_SIGNATURE');
  });

  it('verifies the same credential 100 times in a row (functional check; timing lives in scripts/measure-local.js)', async function () {
    const credential = issueCredential();

    for (let i = 0; i < 100; i++) {
      const result = await verifierService.verifyCredential(credential);
      expect(result.valid).to.equal(true);
    }
  });

  describe('validity period', function () {
    it('fails with CREDENTIAL_NOT_YET_VALID when validFrom is beyond the clock tolerance', async function () {
      const credential = issueCredential({ validFrom: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
      expect((await verifierService.verifyCredential(credential)).reason).to.equal('CREDENTIAL_NOT_YET_VALID');
    });

    it('accepts a validFrom inside the clock tolerance', async function () {
      const credential = issueCredential({ validFrom: new Date(Date.now() + 30 * 1000).toISOString() });
      expect((await verifierService.verifyCredential(credential)).reason).to.equal('VALID');
    });

    it('fails with MALFORMED_CREDENTIAL on an unparsable timestamp', async function () {
      const badUntil = issueCredential();
      badUntil.validUntil = 'not-a-date';
      expect((await verifierService.verifyCredential(badUntil)).reason).to.equal('MALFORMED_CREDENTIAL');
      const badFrom = issueCredential();
      badFrom.validFrom = 'yesterday';
      expect((await verifierService.verifyCredential(badFrom)).reason).to.equal('MALFORMED_CREDENTIAL');
    });

    it('fails with MALFORMED_CREDENTIAL when validUntil is earlier than validFrom', async function () {
      const credential = issueCredential({ validFrom: '2026-01-02T00:00:00Z', validUntil: '2026-01-01T00:00:00Z' });
      expect((await verifierService.verifyCredential(credential)).reason).to.equal('MALFORMED_CREDENTIAL');
    });
  });

  describe('per-step timing', function () {
    it('gives the same results with timing on and off', async function () {
      const timed = new CredentialVerifierService(didRegistry, { timing: true });
      const tampered = issueCredential();
      tampered.credentialSubject.accessLevel = 'admin';
      const credentials = [
        issueCredential(),
        issueCredential({ validFrom: '2024-01-01T00:00:00Z', validUntil: '2024-01-02T00:00:00Z' }),
        tampered,
        {},
      ];
      for (const credential of credentials) {
        const plain = await verifierService.verifyCredential(credential);
        const withTiming = await timed.verifyCredential(credential);
        expect(withTiming.valid).to.equal(plain.valid);
        expect(withTiming.reason).to.equal(plain.reason);
        expect(plain.timings).to.equal(undefined);
        expect(withTiming.timings).to.be.an('object');
      }
      const full = await timed.verifyCredential(issueCredential());
      expect(Object.keys(full.timings)).to.deep.equal(['V1', 'B0', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8']);
    });
  });

  describe('same-block reads', function () {
    function recordingRegistry(base, { blockNumber = 100, documentActive = true } = {}) {
      const calls = [];
      return {
        calls,
        provider: { getBlockNumber: async () => blockNumber },
        async verifyDID(did, overrides) {
          calls.push(['verifyDID', overrides]);
          return base.verifyDID(did);
        },
        async getDIDDocument(did, overrides) {
          calls.push(['getDIDDocument', overrides]);
          const doc = await base.getDIDDocument(did);
          return { id: doc.id, active: documentActive && doc.active, verificationMethods: doc.verificationMethods };
        },
        async isCredentialRevoked(did, id, overrides) {
          calls.push(['isCredentialRevoked', overrides]);
          return base.isCredentialRevoked(did, id);
        },
      };
    }

    it('pins all four reads to one block and reports it', async function () {
      const stub = recordingRegistry(didRegistry, { blockNumber: 4242 });
      const result = await new CredentialVerifierService(stub).verifyCredential(issueCredential());
      expect(result.reason).to.equal('VALID');
      expect(result.checkedAtBlock).to.equal(4242);
      expect(stub.calls.map((c) => c[0])).to.deep.equal(['verifyDID', 'verifyDID', 'getDIDDocument', 'isCredentialRevoked']);
      for (const [, overrides] of stub.calls) {
        expect(overrides).to.deep.equal({ blockTag: 4242 });
      }
    });

    it('pins to the block below the newest with blockLag 1', async function () {
      const stub = recordingRegistry(didRegistry, { blockNumber: 4242 });
      const result = await new CredentialVerifierService(stub, { blockLag: 1 }).verifyCredential(issueCredential());
      expect(result.checkedAtBlock).to.equal(4241);
      for (const [, overrides] of stub.calls) {
        expect(overrides).to.deep.equal({ blockTag: 4241 });
      }
    });

    it('answers as of the pinned block on the chain', async function () {
      const credential = issueCredential();
      const before = await ethers.provider.getBlockNumber();
      await didRegistry.connect(issuer).deactivateDID(issuerDid);
      const after = await ethers.provider.getBlockNumber();
      expect(after).to.be.greaterThan(before);

      const atBefore = await verifierService.verifyCredential(credential, { blockTag: before });
      expect(atBefore.reason).to.equal('VALID');
      expect(atBefore.checkedAtBlock).to.equal(before);

      const atAfter = await verifierService.verifyCredential(credential, { blockTag: after });
      expect(atAfter.reason).to.equal('ISSUER_DID_INACTIVE_OR_UNKNOWN');
      expect((await verifierService.verifyCredential(credential)).checkedAtBlock).to.equal(after);
    });

    it('rejects at V5 when the issuer document is inactive although verifyDID said active', async function () {
      const stub = recordingRegistry(didRegistry, { documentActive: false });
      const result = await new CredentialVerifierService(stub, { timing: true }).verifyCredential(issueCredential());
      expect(result.reason).to.equal('ISSUER_DID_INACTIVE_OR_UNKNOWN');
      expect(result.timings).to.have.property('V5');
      expect(result.timings).to.not.have.property('V6');
    });

    it('returns an error code, never the error message, when a read fails', async function () {
      const failing = {
        provider: { getBlockNumber: async () => 1 },
        async verifyDID() {
          const error = new Error('missing response (url="https://rpc.example/v3/FAKETOKEN")');
          error.code = 'SERVER_ERROR';
          error.url = 'https://rpc.example/v3/FAKETOKEN';
          throw error;
        },
      };
      const result = await new CredentialVerifierService(failing).verifyCredential(issueCredential());
      expect(result.reason).to.equal('VERIFICATION_ERROR');
      expect(result.errorCode).to.equal('SERVER_ERROR');
      expect(JSON.stringify(result)).to.not.match(/https?:|FAKETOKEN/);

      failing.verifyDID = async () => {
        const error = new Error('boom');
        error.code = 'see https://rpc.example/v3/FAKETOKEN';
        throw error;
      };
      const odd = await new CredentialVerifierService(failing).verifyCredential(issueCredential());
      expect(odd.errorCode).to.equal('UNKNOWN_ERROR');
      expect(JSON.stringify(odd)).to.not.match(/https?:|FAKETOKEN/);
    });
  });

  describe('eddsa-jcs-2022 proofs', function () {
    const vector = require('./fixtures/eddsa-jcs-2022-B3.json');

    it('reproduces the W3C test vector (B.3) and verifies it', function () {
      const proof = VerifiableCredentialService.createProof(
        vector.unsecuredDocument, vector.proofOptions, vector.keyPair.secretKeyMultibase
      );
      expect(proof.proofValue).to.equal(vector.expected.proofValue);
      expect(proof['@context']).to.deep.equal(vector.unsecuredDocument['@context']);
      expect(VerifiableCredentialService.verifyProof(
        { ...vector.unsecuredDocument, proof }, vector.keyPair.publicKeyMultibase
      )).to.equal(true);
    });

    it('puts the document @context into the proof of an issued credential', function () {
      const credential = issueCredential();
      expect(credential.proof['@context']).to.deep.equal(credential['@context']);
    });

    it('fails when the document @context no longer starts with the proof @context', async function () {
      const credential = issueCredential();
      credential['@context'] = [credential['@context'][1], credential['@context'][0]];
      expect((await verifierService.verifyCredential(credential)).reason).to.equal('INVALID_SIGNATURE');
    });

    for (const [field, value] of [
      ['type', 'Ed25519Signature2020'],
      ['cryptosuite', 'eddsa-rdfc-2022'],
      ['proofPurpose', 'authentication'],
    ]) {
      it(`fails when proof.${field} is ${value}`, async function () {
        const credential = issueCredential();
        credential.proof[field] = value;
        expect((await verifierService.verifyCredential(credential)).reason).to.equal('INVALID_SIGNATURE');
      });
    }

    it('still verifies a credential signed the version 1.0.0 way (no proof @context)', async function () {
      const crypto = require('crypto');
      const { base58btc, canonicalize } = require('../src/vc/vc-service');
      const sha = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest();
      const { proof, ...unsecured } = issueCredential();
      const { proofValue, '@context': proofContext, ...legacyConfig } = proof;
      const signature = crypto.sign(
        null,
        Buffer.concat([sha(canonicalize(legacyConfig)), sha(canonicalize(unsecured))]),
        VerifiableCredentialService.importPrivateKey(issuerKeys.privateKeyMultibase)
      );
      const legacy = { ...unsecured, proof: { ...legacyConfig, proofValue: `z${base58btc(signature)}` } };
      expect(legacy.proof).to.not.have.property('@context');
      expect((await verifierService.verifyCredential(legacy)).reason).to.equal('VALID');
    });
  });
});
