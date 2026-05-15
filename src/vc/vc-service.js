const crypto = require('crypto');

const VC_V2_CONTEXT = 'https://www.w3.org/ns/credentials/v2';
const EDDSA_CONTEXT = 'https://w3id.org/security/data-integrity/v2';
const DEFAULT_VALIDITY_DAYS = 365;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base64url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function base58btc(buffer) {
  const bytes = Buffer.from(buffer);
  let value = 0n;

  for (const byte of bytes) {
    value = (value << 8n) + BigInt(byte);
  }

  let encoded = '';
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    value /= 58n;
  }

  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = BASE58_ALPHABET[0] + encoded;
  }

  return encoded || BASE58_ALPHABET[0];
}

function fromBase58btc(value) {
  let decoded = 0n;

  for (const char of value) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('Invalid base58btc value');
    }
    decoded = decoded * 58n + BigInt(index);
  }

  let hex = decoded.toString(16);
  if (hex.length % 2) {
    hex = `0${hex}`;
  }

  let bytes = decoded === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  for (const char of value) {
    if (char !== BASE58_ALPHABET[0]) break;
    bytes = Buffer.concat([Buffer.from([0]), bytes]);
  }

  return bytes;
}

function rawEd25519PublicKeyFromMultibase(publicKeyMultibase) {
  const decoded = fromBase58btc(publicKeyMultibase.replace(/^z/, ''));
  const prefix = decoded.slice(0, 2);

  if (prefix.length !== 2 || prefix[0] !== 0xed || prefix[1] !== 0x01) {
    throw new Error('Invalid Ed25519 multikey prefix');
  }

  const rawPublicKey = decoded.slice(2);
  if (rawPublicKey.length !== 32) {
    throw new Error('Invalid Ed25519 public key length');
  }

  return rawPublicKey;
}

function rawEd25519SecretKeyFromMultibase(secretKeyMultibase) {
  const decoded = fromBase58btc(secretKeyMultibase.replace(/^z/, ''));
  const prefix = decoded.slice(0, 2);

  if (prefix.length !== 2 || prefix[0] !== 0x80 || prefix[1] !== 0x26) {
    throw new Error('Invalid Ed25519 secret multikey prefix');
  }

  const rawSecretKey = decoded.slice(2);
  if (rawSecretKey.length !== 32) {
    throw new Error('Invalid Ed25519 secret key length');
  }

  return rawSecretKey;
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(',')}}`;
}

function credentialPayload(credential) {
  const { proof, ...payload } = credential;
  return payload;
}

function nowIso() {
  return new Date().toISOString();
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

class VerifiableCredentialService {
  static generateEd25519KeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    const privateKeyJwk = privateKey.export({ format: 'jwk' });
    const publicKeyMulticodec = Buffer.concat([
      Buffer.from([0xed, 0x01]),
      publicKeyDer.slice(-32),
    ]);
    const secretKeyMulticodec = Buffer.concat([
      Buffer.from([0x80, 0x26]),
      fromBase64url(privateKeyJwk.d),
    ]);
    const secretKeyMultibase = `z${base58btc(secretKeyMulticodec)}`;

    return {
      publicKeyMultibase: `z${base58btc(publicKeyMulticodec)}`,
      secretKeyMultibase,
      privateKeyMultibase: secretKeyMultibase,
    };
  }

  static importPrivateKey(privateKeyMultibase) {
    const ed25519Pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');

    return crypto.createPrivateKey({
      key: Buffer.concat([ed25519Pkcs8Prefix, rawEd25519SecretKeyFromMultibase(privateKeyMultibase)]),
      type: 'pkcs8',
      format: 'der',
    });
  }

  static importPublicKey(publicKeyMultibase) {
    const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');

    return crypto.createPublicKey({
      key: Buffer.concat([ed25519SpkiPrefix, rawEd25519PublicKeyFromMultibase(publicKeyMultibase)]),
      type: 'spki',
      format: 'der',
    });
  }

  static createVerificationMethod(issuerDid, publicKeyMultibase, keyId = 'key-1') {
    return {
      id: `${issuerDid}#${keyId}`,
      type: 'Multikey',
      controller: issuerDid,
      publicKeyMultibase,
    };
  }

  static issueCredential({
    issuerDid,
    subjectDid,
    privateKeyMultibase,
    verificationMethod,
    claims = {},
    credentialType = 'IdentityCredential',
    credentialId = `urn:uuid:${crypto.randomUUID()}`,
    registryAddress = 'local-hardhat',
    validFrom = nowIso(),
    validUntil,
  }) {
    if (!issuerDid || !subjectDid || !privateKeyMultibase || !verificationMethod) {
      throw new Error('issuerDid, subjectDid, privateKeyMultibase, and verificationMethod are required');
    }

    const credential = {
      '@context': [VC_V2_CONTEXT, EDDSA_CONTEXT],
      id: credentialId,
      type: ['VerifiableCredential', credentialType],
      issuer: issuerDid,
      validFrom,
      validUntil: validUntil || addDays(new Date(validFrom), DEFAULT_VALIDITY_DAYS),
      credentialSubject: {
        id: subjectDid,
        ...claims,
      },
      credentialStatus: {
        id: `ethereum:${registryAddress}/revocation/${encodeURIComponent(issuerDid)}/${encodeURIComponent(credentialId)}`,
        type: 'EthereumRevocationRegistry2026',
        revocationRegistry: registryAddress,
        revocationMethod: 'DIDRegistry.isCredentialRevoked(string,string)',
      },
    };

    // eddsa-jcs-2022 §4.1: build proof configuration, canonicalize both
    // documents independently, hash each with SHA-256, concatenate, then sign.
    const proofConfig = {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: nowIso(),
      verificationMethod: verificationMethod.id || verificationMethod,
      proofPurpose: 'assertionMethod',
    };

    const proofConfigHash = crypto
      .createHash('sha256')
      .update(Buffer.from(canonicalize(proofConfig), 'utf8'))
      .digest();

    const documentHash = crypto
      .createHash('sha256')
      .update(Buffer.from(canonicalize(credential), 'utf8'))
      .digest();

    const hashData = Buffer.concat([proofConfigHash, documentHash]);
    const proofValue = `z${base58btc(crypto.sign(null, hashData, this.importPrivateKey(privateKeyMultibase)))}`;

    return {
      ...credential,
      proof: { ...proofConfig, proofValue },
    };
  }

  static verifySignature(credential, publicKeyMultibase) {
    if (!credential || !credential.proof || !credential.proof.proofValue) {
      return false;
    }

    // Reconstruct proof configuration (identical fields, no proofValue)
    const { proofValue, ...proofConfig } = credential.proof;

    const proofConfigHash = crypto
      .createHash('sha256')
      .update(Buffer.from(canonicalize(proofConfig), 'utf8'))
      .digest();

    const documentHash = crypto
      .createHash('sha256')
      .update(Buffer.from(canonicalize(credentialPayload(credential)), 'utf8'))
      .digest();

    const hashData = Buffer.concat([proofConfigHash, documentHash]);

    return crypto.verify(
      null,
      hashData,
      this.importPublicKey(publicKeyMultibase),
      fromBase58btc(proofValue.replace(/^z/, ''))
    );
  }

  static canonicalizeCredential(credential) {
    return canonicalize(credential);
  }
}

module.exports = {
  VerifiableCredentialService,
  canonicalize,
  credentialPayload,
  rawEd25519PublicKeyFromMultibase,
  rawEd25519SecretKeyFromMultibase,
};
