const { VerifiableCredentialService } = require('./vc-service');

class CredentialVerifierService {
  constructor(didRegistry) {
    this.didRegistry = didRegistry;
  }

  async verifyCredential(credential) {
    const checkedAt = new Date().toISOString();

    try {
      if (!credential || !credential.issuer || !credential.credentialSubject?.id) {
        return this.result(false, 'MALFORMED_CREDENTIAL', credential, checkedAt);
      }

      if (!credential.proof?.verificationMethod) {
        return this.result(false, 'MISSING_PROOF', credential, checkedAt);
      }

      const issuerDid = credential.issuer;
      const subjectDid = credential.credentialSubject.id;
      const credentialId = credential.id;

      if (!(await this.didRegistry.verifyDID(issuerDid))) {
        return this.result(false, 'ISSUER_DID_INACTIVE_OR_UNKNOWN', credential, checkedAt);
      }

      if (!(await this.didRegistry.verifyDID(subjectDid))) {
        return this.result(false, 'SUBJECT_DID_INACTIVE_OR_UNKNOWN', credential, checkedAt);
      }

      if (credential.validUntil && Date.parse(credential.validUntil) <= Date.now()) {
        return this.result(false, 'CREDENTIAL_EXPIRED', credential, checkedAt);
      }

      const issuerDocument = await this.didRegistry.getDIDDocument(issuerDid);
      const verificationMethod = this.findVerificationMethod(
        issuerDocument.verificationMethods,
        credential.proof.verificationMethod
      );

      if (!verificationMethod) {
        return this.result(false, 'VERIFICATION_METHOD_NOT_FOUND', credential, checkedAt);
      }

      if (!VerifiableCredentialService.verifySignature(credential, verificationMethod.publicKeyMultibase)) {
        return this.result(false, 'INVALID_SIGNATURE', credential, checkedAt);
      }

      if (await this.didRegistry.isCredentialRevoked(issuerDid, credentialId)) {
        return this.result(false, 'CREDENTIAL_REVOKED', credential, checkedAt);
      }

      return this.result(true, 'VALID', credential, checkedAt);
    } catch (error) {
      return {
        valid: false,
        reason: 'VERIFICATION_ERROR',
        error: error.message,
        checkedAt,
      };
    }
  }

  findVerificationMethod(verificationMethods, id) {
    for (const method of verificationMethods) {
      const parsed = this.parseVerificationMethod(method);
      if (parsed && parsed.id === id) {
        return parsed;
      }
    }

    return null;
  }

  parseVerificationMethod(method) {
    if (typeof method !== 'string') {
      return method;
    }

    try {
      return JSON.parse(method);
    } catch {
      return null;
    }
  }

  result(valid, reason, credential, checkedAt) {
    return {
      valid,
      reason,
      issuerDid: credential?.issuer || null,
      subjectDid: credential?.credentialSubject?.id || null,
      credentialId: credential?.id || null,
      checkedAt,
    };
  }
}

module.exports = { CredentialVerifierService };
