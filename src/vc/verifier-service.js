const { VerifiableCredentialService, VC_V2_CONTEXT } = require('./vc-service');

// Default clock tolerance for validFrom. RFC 7519 (sections 4.1.4 and 4.1.5) allows "some small leeway, usually
// no more than a few minutes, to account for clock skew"; one minute is used here.
const DEFAULT_CLOCK_TOLERANCE_MS = 60 * 1000;

// VC 2.0 (section 4.9) requires validFrom and validUntil to be XML Schema dateTimeStamp values: a date, a time and a
// time zone. Anything else (no time zone, which Date.parse would read in the verifier's local zone, or other formats
// Date.parse accepts) is rejected.
// Date.parse rolls impossible dates over (2026-02-30 becomes 2026-03-02), so the fields are checked as well.
const DATE_TIME_STAMP = /^(-?\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

function isValidDate(value) {
  const m = typeof value === 'string' && DATE_TIME_STAMP.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return false;
  if (m[9] !== undefined && (Number(m[9]) > 14 || Number(m[10]) > 59)) return false;
  return !Number.isNaN(Date.parse(value));
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

// Error codes only: never copy error.message, which can contain the RPC URL. ethers v5 wraps a JSON-RPC error or a
// failed HTTP request in SERVER_ERROR or CALL_EXCEPTION and keeps the cause in error.error (or error.serverError),
// so the chain is walked (four levels at most): a string code of capitals is kept, a JSON-RPC error number becomes
// RPC_<n> and an HTTP status HTTP_<n>, joined with "/" (for example SERVER_ERROR/HTTP_429). If any message or response
// body in the chain says that the node lacks the block, the fixed code BLOCK_UNAVAILABLE is added; only that constant
// is written, never the text. Nothing recognisable gives UNKNOWN_ERROR. The Sepolia scripts use this same function
// (scripts/lib/rpc.js), so a failure is reported alike in every mode.
const BLOCK_MISSING = /header not found|unknown block|block not found|missing trie node/i;

function errorCode(error) {
  const parts = [];
  let blockMissing = false;
  const seen = new Set();
  let level = [error];
  for (let depth = 0; depth < 4 && level.length; depth++) {
    const next = [];
    for (const e of level) {
      if (!e || typeof e !== 'object' || seen.has(e)) continue;
      seen.add(e);
      const { code, status } = e;
      if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) parts.push(code);
      else if (typeof code === 'number' && Number.isInteger(code)) parts.push(`RPC_${code}`);
      if (Number.isInteger(status)) parts.push(`HTTP_${status}`);
      // ethers 5.8 keeps no status when HTTP 429 used up its attempts (throttleLimit): fetchJson then throws
      // SERVER_ERROR with reason "failed response", which it does for nothing else on a POST (redirects are followed
      // only for GET).
      else if (code === 'SERVER_ERROR' && e.reason === 'failed response') parts.push('HTTP_429');
      for (const text of [e.message, e.body]) if (typeof text === 'string' && BLOCK_MISSING.test(text)) blockMissing = true;
      next.push(e.error, e.serverError);
    }
    level = next;
  }
  const unique = [...new Set(parts)];
  if (blockMissing) unique.push('BLOCK_UNAVAILABLE');
  return unique.length ? unique.join('/') : 'UNKNOWN_ERROR';
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
    const clockToleranceMs = options.clockToleranceMs ?? DEFAULT_CLOCK_TOLERANCE_MS;
    if (typeof clockToleranceMs !== 'number' || !Number.isFinite(clockToleranceMs) || clockToleranceMs < 0) {
      throw new TypeError('clockToleranceMs must be a finite number of milliseconds, 0 or more');
    }
    const blockLag = options.blockLag ?? 0;
    if (!isNonNegativeInteger(blockLag)) {
      throw new TypeError('blockLag must be an integer, 0 or more');
    }
    this.didRegistry = didRegistry;
    this.clockToleranceMs = clockToleranceMs;
    this.timing = Boolean(options.timing);
    this.blockLag = blockLag;
    this.provider = options.provider || didRegistry.provider;
  }

  /**
   * Verify a credential. All four chain reads (V2, V3, V5, V7) are pinned to one block, so every answer
   * describes the same chain state. Unless options.blockTag is given, step B0 reads the newest block number.
   */
  async verifyCredential(credential, options = {}) {
    // One moment for the whole verification: the validity period (V4) is judged at the time reported as checkedAt.
    const nowMs = Date.now();
    const checkedAt = new Date(nowMs).toISOString();
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
          typeof credential.issuer !== 'string' || credential.issuer === '' ||
          typeof credential.credentialSubject?.id !== 'string' || credential.credentialSubject.id === '') {
        step('V1');
        return done(false, 'MALFORMED_CREDENTIAL');
      }
      // VC 2.0 (sections 4.3 and 4.5): the base context comes first and the type includes VerifiableCredential.
      // The VC 1.1 date properties are rejected rather than ignored, so a VC 1.1 expiry cannot be skipped.
      const contexts = Array.isArray(credential['@context']) ? credential['@context'] : [credential['@context']];
      const types = Array.isArray(credential.type) ? credential.type : [credential.type];
      if (contexts[0] !== VC_V2_CONTEXT || !types.includes('VerifiableCredential') ||
          credential.issuanceDate !== undefined || credential.expirationDate !== undefined) {
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

      // B0: the block that every read is pinned to. A caller's block must be a block number (an integer, 0 or more);
      // a past block gives the answer as of that block, and the result reports it.
      if (options.blockTag !== undefined) {
        if (!isNonNegativeInteger(options.blockTag)) {
          throw Object.assign(new Error('blockTag'), { code: 'INVALID_BLOCK_TAG' });
        }
        checkedAtBlock = options.blockTag;
      } else {
        // A plain eth_blockNumber request: ethers' getBlockNumber() never goes below the highest number it has seen,
        // which can pin the reads to a block that the node answering them does not have yet.
        const newest = typeof this.provider.send === 'function'
          ? Number.parseInt(await this.provider.send('eth_blockNumber', []), 16)
          : await this.provider.getBlockNumber();
        checkedAtBlock = Math.max(0, newest - this.blockLag);
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
      const now = nowMs;
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
      // The method must be a Multikey of the issuer: controlled by the issuer DID and named under it. The registry has
      // no assertionMethod relationship, so any such method of the issuer can sign credentials.
      const verificationMethod = this.findVerificationMethod(
        issuerDocument.verificationMethods,
        credential.proof.verificationMethod
      );
      if (!verificationMethod || verificationMethod.type !== 'Multikey' || verificationMethod.controller !== issuerDid ||
          typeof verificationMethod.id !== 'string' || !verificationMethod.id.startsWith(`${issuerDid}#`)) {
        step('V5');
        return done(false, 'VERIFICATION_METHOD_NOT_FOUND');
      }
      step('V5');

      // V6: eddsa-jcs-2022 proof (type, cryptosuite, purpose, expiry, @context, signature)
      const proof = credential.proof;
      if (proof.type !== 'DataIntegrityProof' ||
          proof.cryptosuite !== 'eddsa-jcs-2022' ||
          proof.proofPurpose !== 'assertionMethod' ||
          (proof.expires !== undefined && (!isValidDate(proof.expires) || Date.parse(proof.expires) <= now)) ||
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

module.exports = { CredentialVerifierService, DEFAULT_CLOCK_TOLERANCE_MS, errorCode };
