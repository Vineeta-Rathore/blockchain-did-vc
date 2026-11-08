const { VerifiableCredentialService } = require('./vc-service');

// Default clock tolerance for validFrom. RFC 7519 (sections 4.1.4 and 4.1.5) allows "some small leeway, usually
// no more than a few minutes, to account for clock skew"; one minute is used here.
const DEFAULT_CLOCK_TOLERANCE_MS = 60 * 1000;

function isValidDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

// Error codes only: never copy error.message, which can contain the RPC URL.
function errorCode(error) {
  const code = error && error.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'UNKNOWN_ERROR';
}

class CredentialVerifierService {
  /**
   * @param {object} didRegistry ethers Contract (or a stub with the same read functions)
   * @param {object} [options]
   * @param {number} [options.clockToleranceMs] tolerance for validFrom (default 60 s)
   * @param {boolean} [options.timing] record the duration of each step
   * @param {number} [options.blockLag] pin the reads this many blocks below the newest (default 0)
   * @param {object} [options.provider] provider used for the block number (default didRegistry.provider)
   */
  constructor(didRegistry, options = {}) {
    this.didRegistry = didRegistry;
    this.clockToleranceMs = options.clockToleranceMs ?? DEFAULT_CLOCK_TOLERANCE_MS;
    this.timing = Boolean(options.timing);
    this.blockLag = options.blockLag ?? 0;
    this.provider = options.provider || didRegistry.provider;
  }

  /**
   * Verify a credential. All four chain reads (V2, V3, V5, V7) are pinned to one block, so every answer
   * describes the same chain state. Unless options.blockTag is given, step B0 reads the newest block number.
   */
  async verifyCredential(credential, options = {}) {
    const checkedAt = new Date().toISOString();
    const timings = this.timing ? {} : null;
    let checkedAtBlock = null;
    let mark = this.timing ? process.hrtime.bigint() : null;
    const step = (name) => {
      if (!timings) return;
      const now = process.hrtime.bigint();
      timings[name] = Number(now - mark) / 1e6;
      mark = now;
    };
    const done = (valid, reason) => this.result(valid, reason, credential, checkedAt, checkedAtBlock, timings);

    try {
      // V1: structure and validity dates. Revocation is keyed by the credential id, so a credential without a
      // non-empty string id cannot be checked at V7 and is rejected here.
      if (!credential || typeof credential.id !== 'string' || credential.id === '' ||
          !credential.issuer || !credential.credentialSubject?.id) {
        step('V1');
        return done(false, 'MALFORMED_CREDENTIAL');
      }
      if (!credential.proof?.verificationMethod) {
        step('V1');
        return done(false, 'MISSING_PROOF');
      }
      const { validFrom, validUntil } = credential;
      if ((validFrom !== undefined && !isValidDate(validFrom)) ||
          (validUntil !== undefined && !isValidDate(validUntil)) ||
          (validFrom !== undefined && validUntil !== undefined && Date.parse(validUntil) < Date.parse(validFrom))) {
        step('V1');
        return done(false, 'MALFORMED_CREDENTIAL');
      }
      step('V1');

      const issuerDid = credential.issuer;
      const subjectDid = credential.credentialSubject.id;
      const credentialId = credential.id;

      // B0: the block that every read is pinned to
      if (Number.isInteger(options.blockTag)) {
        checkedAtBlock = options.blockTag;
      } else {
        checkedAtBlock = Math.max(0, (await this.provider.getBlockNumber()) - this.blockLag);
      }
      const at = { blockTag: checkedAtBlock };
      step('B0');

      // V2: issuer DID exists and is active
      if (!(await this.didRegistry.verifyDID(issuerDid, at))) {
        step('V2');
        return done(false, 'ISSUER_DID_INACTIVE_OR_UNKNOWN');
      }
      step('V2');

      // V3: subject DID exists and is active
      if (!(await this.didRegistry.verifyDID(subjectDid, at))) {
        step('V3');
        return done(false, 'SUBJECT_DID_INACTIVE_OR_UNKNOWN');
      }
      step('V3');

      // V4: validity period (validFrom with the clock tolerance, then validUntil)
      const now = Date.now();
      if (validFrom !== undefined && Date.parse(validFrom) > now + this.clockToleranceMs) {
        step('V4');
        return done(false, 'CREDENTIAL_NOT_YET_VALID');
      }
      if (validUntil !== undefined && Date.parse(validUntil) <= now) {
        step('V4');
        return done(false, 'CREDENTIAL_EXPIRED');
      }
      step('V4');

      // V5: issuer document at the same block; it must be active and be the issuer's own document
      const issuerDocument = await this.didRegistry.getDIDDocument(issuerDid, at);
      if (!issuerDocument || issuerDocument.active !== true || issuerDocument.id !== issuerDid) {
        step('V5');
        return done(false, 'ISSUER_DID_INACTIVE_OR_UNKNOWN');
      }
      const verificationMethod = this.findVerificationMethod(
        issuerDocument.verificationMethods,
        credential.proof.verificationMethod
      );
      if (!verificationMethod) {
        step('V5');
        return done(false, 'VERIFICATION_METHOD_NOT_FOUND');
      }
      step('V5');

      // V6: eddsa-jcs-2022 proof (type, cryptosuite, purpose, context prefix, signature)
      const proof = credential.proof;
      if (proof.type !== 'DataIntegrityProof' ||
          proof.cryptosuite !== 'eddsa-jcs-2022' ||
          proof.proofPurpose !== 'assertionMethod' ||
          !VerifiableCredentialService.verifyProof(credential, verificationMethod.publicKeyMultibase)) {
        step('V6');
        return done(false, 'INVALID_SIGNATURE');
      }
      step('V6');

      // V7: revocation, at the same block
      if (await this.didRegistry.isCredentialRevoked(issuerDid, credentialId, at)) {
        step('V7');
        return done(false, 'CREDENTIAL_REVOKED');
      }
      step('V7');

      // V8: accept
      step('V8');
      return done(true, 'VALID');
    } catch (error) {
      return {
        valid: false,
        reason: 'VERIFICATION_ERROR',
        errorCode: errorCode(error),
        checkedAt,
        checkedAtBlock,
        ...(timings ? { timings } : {}),
      };
    }
  }

  findVerificationMethod(verificationMethods, id) {
    for (const method of verificationMethods || []) {
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

  result(valid, reason, credential, checkedAt, checkedAtBlock, timings) {
    return {
      valid,
      reason,
      issuerDid: credential?.issuer || null,
      subjectDid: credential?.credentialSubject?.id || null,
      credentialId: credential?.id || null,
      checkedAt,
      checkedAtBlock,
      ...(timings ? { timings } : {}),
    };
  }
}

module.exports = { CredentialVerifierService, DEFAULT_CLOCK_TOLERANCE_MS };
