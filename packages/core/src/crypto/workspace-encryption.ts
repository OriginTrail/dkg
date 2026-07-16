import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  webcrypto,
  type KeyObject,
} from 'node:crypto';
import {
  ENCRYPTED_WORKSPACE_CIPHER_ALGORITHM,
  ENCRYPTED_WORKSPACE_ENVELOPE_TYPE,
  ENCRYPTED_WORKSPACE_ENVELOPE_VERSION,
  ENCRYPTED_WORKSPACE_KEY_AGREEMENT_ALGORITHM,
  ENCRYPTED_WORKSPACE_KEY_WRAP_ALGORITHM,
  computeEncryptedWorkspaceAAD,
  type EncryptedWorkspaceAADFields,
  type EncryptedWorkspacePayloadMsg,
} from '../proto/encrypted-workspace.js';

export const WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE = 'dkg.workspace.recipient-encryption-key.v1';
export const WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519 = 'X25519';
export const WORKSPACE_AGENT_ENCRYPTION_KEY_PROOF_DOMAIN = 'dkg.workspace.agent-encryption-key-proof.v1';
export const WORKSPACE_AGENT_ENCRYPTION_KEY_REVOCATION_DOMAIN = 'dkg.workspace.agent-encryption-key-revocation.v1';
export const WORKSPACE_ENCRYPTION_KEY_BYTES = 32;
export const WORKSPACE_X25519_KEY_BYTES = 32;
export const WORKSPACE_ENCRYPTION_NONCE_BYTES = 12;

export interface WorkspaceRecipientEncryptionKey {
  purpose: typeof WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE;
  recipientId: string;
  recipientKeyId: string;
  encryptionKeyAlgorithm: typeof WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519;
  publicKeyBytes?: Uint8Array;
  privateKeyBytes?: Uint8Array;
}

export interface EncryptWorkspacePayloadInput extends Omit<EncryptedWorkspaceAADFields, 'version' | 'type' | 'keyAgreementAlgorithm' | 'ephemeralPublicKey'> {
  plaintext: Uint8Array;
  recipients: readonly WorkspaceRecipientEncryptionKey[];
  randomBytes?: (length: number) => Uint8Array;
}

export interface DecryptedWorkspacePayload {
  plaintext: Uint8Array;
  recipientId: string;
  recipientKeyId: string;
}

export interface WorkspaceAgentEncryptionKeyProofFields {
  agentAddress: string;
  encryptionKeyAlgorithm: typeof WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519;
  publicKeyBytes: Uint8Array;
}

export interface WorkspaceAgentEncryptionKeyRevocationFields {
  agentAddress: string;
  encryptionKeyAlgorithm: typeof WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519;
  publicKeyBytes: Uint8Array;
  revokedAt: string;
}

type WorkspaceEncryptionMetadata = Required<Pick<
  EncryptedWorkspaceAADFields,
  | 'version'
  | 'type'
  | 'contextGraphId'
  | 'senderIdentity'
  | 'operationId'
  | 'shareOperationId'
  | 'timestampMs'
  | 'subGraphName'
  | 'keyAgreementAlgorithm'
  | 'ephemeralPublicKey'
>>;

export function generateWorkspaceRecipientEncryptionKey(
  recipientId: string,
  recipientKeyId: string,
  randomBytes?: (length: number) => Uint8Array,
): WorkspaceRecipientEncryptionKey {
  assertNonEmpty('recipientId', recipientId);
  assertNonEmpty('recipientKeyId', recipientKeyId);
  const privateKeyBytes = checkedRandomBytes(
    WORKSPACE_X25519_KEY_BYTES,
    randomBytes ?? secureRandomBytes,
  );
  return {
    purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
    recipientId,
    recipientKeyId,
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes: x25519PublicFromPrivate(privateKeyBytes),
    privateKeyBytes,
  };
}

export async function encryptWorkspacePayload(
  input: EncryptWorkspacePayloadInput,
): Promise<EncryptedWorkspacePayloadMsg> {
  assertSupportedEncryptOverrides(input);

  if (input.recipients.length === 0) {
    throw new Error('At least one recipient encryption key is required');
  }

  const randomBytes = input.randomBytes ?? secureRandomBytes;
  const ephemeralPrivateKey = checkedRandomBytes(WORKSPACE_X25519_KEY_BYTES, randomBytes);
  const ephemeralPublicKey = x25519PublicFromPrivate(ephemeralPrivateKey);
  const metadata = workspaceMetadata({
    ...input,
    keyAgreementAlgorithm: ENCRYPTED_WORKSPACE_KEY_AGREEMENT_ALGORITHM,
    ephemeralPublicKey,
  });
  const aad = computeEncryptedWorkspaceAAD(metadata);

  const contentKey = checkedRandomBytes(WORKSPACE_ENCRYPTION_KEY_BYTES, randomBytes);
  const payloadNonce = checkedRandomBytes(WORKSPACE_ENCRYPTION_NONCE_BYTES, randomBytes);
  const ciphertext = await aesGcmEncrypt(contentKey, input.plaintext, payloadNonce, aad);
  const recipients = [];

  for (const recipient of input.recipients) {
    validateRecipientEncryptionKey(recipient, 'encrypt');
    const nonce = checkedRandomBytes(WORKSPACE_ENCRYPTION_NONCE_BYTES, randomBytes);
    const recipientKeyAAD = computeRecipientKeyAAD(
      metadata,
      recipient.recipientId,
      recipient.recipientKeyId,
    );
    const keyWrapKey = deriveRecipientKeyWrapKey(
      x25519SharedSecret(ephemeralPrivateKey, recipient.publicKeyBytes!),
      recipientKeyAAD,
    );
    recipients.push({
      recipientId: recipient.recipientId,
      recipientKeyId: recipient.recipientKeyId,
      algorithm: ENCRYPTED_WORKSPACE_KEY_WRAP_ALGORITHM,
      nonce,
      encryptedKey: await aesGcmEncrypt(keyWrapKey, contentKey, nonce, recipientKeyAAD),
    });
  }

  return {
    ...metadata,
    cipherAlgorithm: ENCRYPTED_WORKSPACE_CIPHER_ALGORITHM,
    nonce: payloadNonce,
    ciphertext,
    recipients,
  };
}

export async function decryptWorkspacePayload(
  envelope: EncryptedWorkspacePayloadMsg,
  recipientKeys: readonly WorkspaceRecipientEncryptionKey[],
): Promise<DecryptedWorkspacePayload> {
  assertSupportedEncryptedWorkspaceEnvelope(envelope);
  const metadata = workspaceMetadata(envelope);
  const aad = computeEncryptedWorkspaceAAD(metadata);

  for (const recipientKey of recipientKeys) {
    validateRecipientEncryptionKey(recipientKey, 'decrypt');
    for (const slot of envelope.recipients) {
      if (
        slot.recipientId !== recipientKey.recipientId ||
        slot.recipientKeyId !== recipientKey.recipientKeyId
      ) {
        continue;
      }

      let contentKey: Uint8Array;
      try {
        const recipientKeyAAD = computeRecipientKeyAAD(metadata, slot.recipientId, slot.recipientKeyId);
        const keyWrapKey = deriveRecipientKeyWrapKey(
          x25519SharedSecret(recipientKey.privateKeyBytes!, envelope.ephemeralPublicKey),
          recipientKeyAAD,
        );
        contentKey = await aesGcmDecrypt(
          keyWrapKey,
          slot.encryptedKey,
          slot.nonce,
          recipientKeyAAD,
        );
      } catch {
        continue;
      }

      return {
        recipientId: slot.recipientId,
        recipientKeyId: slot.recipientKeyId,
        plaintext: await aesGcmDecrypt(contentKey, envelope.ciphertext, envelope.nonce, aad),
      };
    }
  }

  throw new Error('No matching recipient encryption key could decrypt workspace payload');
}

export function assertSupportedEncryptedWorkspaceEnvelope(envelope: EncryptedWorkspacePayloadMsg): void {
  if (envelope.version !== ENCRYPTED_WORKSPACE_ENVELOPE_VERSION) {
    throw new Error(`Unsupported encrypted workspace envelope version: ${envelope.version}`);
  }
  if (envelope.type !== ENCRYPTED_WORKSPACE_ENVELOPE_TYPE) {
    throw new Error(`Unsupported encrypted workspace envelope type: ${envelope.type}`);
  }
  if (envelope.cipherAlgorithm !== ENCRYPTED_WORKSPACE_CIPHER_ALGORITHM) {
    throw new Error(`Unsupported encrypted workspace cipher algorithm: ${envelope.cipherAlgorithm}`);
  }
  if (envelope.keyAgreementAlgorithm !== ENCRYPTED_WORKSPACE_KEY_AGREEMENT_ALGORITHM) {
    throw new Error(`Unsupported encrypted workspace key agreement algorithm: ${envelope.keyAgreementAlgorithm}`);
  }
  if (envelope.ephemeralPublicKey.length !== WORKSPACE_X25519_KEY_BYTES) {
    throw new Error('Encrypted workspace ephemeral public key must be 32 bytes');
  }
  if (envelope.nonce.length !== WORKSPACE_ENCRYPTION_NONCE_BYTES) {
    throw new Error('Encrypted workspace payload nonce must be 12 bytes');
  }
  if (envelope.recipients.length === 0) {
    throw new Error('Encrypted workspace envelope must include at least one recipient key slot');
  }

  for (const slot of envelope.recipients) {
    assertNonEmpty('recipientId', slot.recipientId);
    assertNonEmpty('recipientKeyId', slot.recipientKeyId);
    if (slot.algorithm !== ENCRYPTED_WORKSPACE_KEY_WRAP_ALGORITHM) {
      throw new Error(`Unsupported encrypted workspace key wrap algorithm: ${slot.algorithm}`);
    }
    if (slot.nonce.length !== WORKSPACE_ENCRYPTION_NONCE_BYTES) {
      throw new Error('Encrypted workspace recipient key slot nonce must be 12 bytes');
    }
    if (slot.encryptedKey.length === 0) {
      throw new Error('Encrypted workspace recipient key slot is empty');
    }
  }
}

export function computeWorkspaceAgentEncryptionKeyProofPayload(
  fields: WorkspaceAgentEncryptionKeyProofFields,
): Uint8Array {
  if (fields.encryptionKeyAlgorithm !== WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519) {
    throw new Error(`Unsupported workspace agent encryption key algorithm: ${fields.encryptionKeyAlgorithm}`);
  }
  assertNonEmpty('agentAddress', fields.agentAddress);
  assertX25519KeyBytes('publicEncryptionKey', fields.publicKeyBytes);
  return concatBytes([
    framedString('domain'),
    framedString(WORKSPACE_AGENT_ENCRYPTION_KEY_PROOF_DOMAIN),
    framedString('agentAddress'),
    framedString(fields.agentAddress.toLowerCase()),
    framedString('encryptionKeyAlgorithm'),
    framedString(fields.encryptionKeyAlgorithm),
    framedString('publicEncryptionKey'),
    framedBytes(fields.publicKeyBytes),
  ]);
}

/**
 * Build the byte payload an agent's secp256k1 wallet signs to revoke a previously
 * registered workspace encryption key. The payload is domain-separated from the
 * registration proof so a stolen registration signature cannot be replayed as a
 * revocation (and vice versa). Verifiers MUST ecrecover() the EIP-191 message hash
 * of this payload and check it matches `agentAddress`.
 */
export function computeWorkspaceAgentEncryptionKeyRevocationPayload(
  fields: WorkspaceAgentEncryptionKeyRevocationFields,
): Uint8Array {
  if (fields.encryptionKeyAlgorithm !== WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519) {
    throw new Error(`Unsupported workspace agent encryption key algorithm: ${fields.encryptionKeyAlgorithm}`);
  }
  assertNonEmpty('agentAddress', fields.agentAddress);
  assertNonEmpty('revokedAt', fields.revokedAt);
  assertX25519KeyBytes('publicEncryptionKey', fields.publicKeyBytes);
  return concatBytes([
    framedString('domain'),
    framedString(WORKSPACE_AGENT_ENCRYPTION_KEY_REVOCATION_DOMAIN),
    framedString('agentAddress'),
    framedString(fields.agentAddress.toLowerCase()),
    framedString('encryptionKeyAlgorithm'),
    framedString(fields.encryptionKeyAlgorithm),
    framedString('publicEncryptionKey'),
    framedBytes(fields.publicKeyBytes),
    framedString('revokedAt'),
    framedString(fields.revokedAt),
  ]);
}

export function workspaceAgentEncryptionKeyId(agentAddress: string, publicKeyBytes: Uint8Array): string {
  assertNonEmpty('agentAddress', agentAddress);
  assertX25519KeyBytes('publicEncryptionKey', publicKeyBytes);
  const digest = createHash('sha256').update(publicKeyBytes).digest('hex').slice(0, 32);
  return `did:dkg:agent:${agentAddress.toLowerCase()}#x25519-${digest}`;
}

export function encodeWorkspaceEncryptionKey(bytes: Uint8Array): string {
  assertX25519KeyBytes('workspaceEncryptionKey', bytes);
  return Buffer.from(bytes).toString('base64url');
}

export function decodeWorkspaceEncryptionKey(value: string): Uint8Array {
  const raw = value.trim();
  // Single accepted wire form: base64url (43 chars for a 32-byte key)
  // — the only form `encodeWorkspaceEncryptionKey` ever emits and the
  // only form any caller in this workspace ever passes (verified via
  // `rg encodeWorkspaceEncryptionKey` on the full source tree).
  //
  // Why no hex support
  // -------------------
  // The original implementation also accepted `0x…` hex, dispatched via
  // `raw.startsWith('0x')`. That heuristic was unsound on three counts
  // and round 5+6 of the bot review on PR #792 walked us through both
  // edges:
  //
  //   1. base64url and hex alphabets overlap. Every ~5,000th random
  //      32-byte x25519 public key encodes to a base64url string whose
  //      first two chars are `0x` (e.g. the captured failure
  //      `0xbT0xAeVsXZ3f7alN53CypTY2D4ejqY6CJlfEg2Yws`). The original
  //      heuristic mis-routed those legitimate base64url payloads to
  //      the hex branch and tripped the 32-byte assert.
  //
  //   2. Tightening the heuristic to "exactly `0x` + 64 hex chars"
  //      fixes (1) but still silently accepts malformed hex like
  //      `0x` + 41 'a's (43 chars, valid base64url alphabet) as a
  //      DIFFERENT 32-byte key — treating user typos as success.
  //
  //   3. There is no third heuristic that resolves both edges, because
  //      base64url that happens to start with `0x` is structurally
  //      indistinguishable from malformed hex of the same length.
  //
  // Resolution: drop hex support entirely. `0x…` strings now decode as
  // base64url unconditionally — which preserves correctness for the
  // ~1/4096 base64url collisions we cannot disambiguate, and removes
  // any "did the user mean hex" magic. Operators who need to feed in a
  // raw hex string can `Buffer.from(hex, 'hex').toString('base64url')`
  // at the boundary; the workspace key wire format is base64url.
  //
  // (The `value.startsWith('0x')` test below is purely diagnostic — if
  // a caller does still pass `0x…hex`, we surface a clear error
  // pointing them at the correct encoding instead of letting the
  // base64url decode succeed with surprising bytes.)
  if (raw.length === 2 + WORKSPACE_X25519_KEY_BYTES * 2 && /^0x[0-9a-fA-F]+$/.test(raw)) {
    throw new Error(
      `workspaceEncryptionKey: refusing to decode 0x-prefixed hex form ` +
        `(64 hex chars). Encode workspace keys as base64url via ` +
        `\`encodeWorkspaceEncryptionKey\`; if you have raw bytes, use ` +
        `\`Buffer.from(hex, 'hex').toString('base64url')\` at the boundary.`,
    );
  }
  const bytes = Buffer.from(
    padBase64(raw.replace(/-/g, '+').replace(/_/g, '/')),
    'base64',
  );
  const out = new Uint8Array(bytes);
  assertX25519KeyBytes('workspaceEncryptionKey', out);
  return out;
}

function validateRecipientEncryptionKey(
  key: WorkspaceRecipientEncryptionKey,
  mode: 'encrypt' | 'decrypt',
): void {
  if (key.purpose !== WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE) {
    throw new Error('Expected a dedicated workspace recipient encryption key');
  }
  assertNonEmpty('recipientId', key.recipientId);
  assertNonEmpty('recipientKeyId', key.recipientKeyId);
  if (key.encryptionKeyAlgorithm !== WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519) {
    throw new Error(`Unsupported workspace recipient encryption key algorithm: ${key.encryptionKeyAlgorithm}`);
  }
  if (mode === 'encrypt') {
    if (!key.publicKeyBytes) {
      throw new Error('Workspace recipient public encryption key is required');
    }
    assertX25519KeyBytes('publicEncryptionKey', key.publicKeyBytes);
  }
  if (mode === 'decrypt') {
    if (!key.privateKeyBytes) {
      throw new Error('Workspace recipient private encryption key is required');
    }
    assertX25519KeyBytes('privateEncryptionKey', key.privateKeyBytes);
  }
}

function assertSupportedEncryptOverrides(fields: object): void {
  const maybeOverrides = fields as { version?: unknown; type?: unknown };
  if (
    maybeOverrides.version !== undefined &&
    maybeOverrides.version !== ENCRYPTED_WORKSPACE_ENVELOPE_VERSION
  ) {
    throw new Error(`Unsupported encrypted workspace envelope version: ${String(maybeOverrides.version)}`);
  }
  if (
    maybeOverrides.type !== undefined &&
    maybeOverrides.type !== ENCRYPTED_WORKSPACE_ENVELOPE_TYPE
  ) {
    throw new Error(`Unsupported encrypted workspace envelope type: ${String(maybeOverrides.type)}`);
  }
}

function workspaceMetadata(
  fields: Omit<EncryptedWorkspaceAADFields, 'version' | 'type'>,
): WorkspaceEncryptionMetadata {
  assertNonEmpty('contextGraphId', fields.contextGraphId);
  assertNonEmpty('senderIdentity', fields.senderIdentity);
  assertNonEmpty('operationId', fields.operationId);
  assertNonEmpty('shareOperationId', fields.shareOperationId);
  if (fields.keyAgreementAlgorithm !== ENCRYPTED_WORKSPACE_KEY_AGREEMENT_ALGORITHM) {
    throw new Error(`Unsupported encrypted workspace key agreement algorithm: ${String(fields.keyAgreementAlgorithm)}`);
  }
  assertX25519KeyBytes('ephemeralPublicKey', fields.ephemeralPublicKey);
  return {
    version: ENCRYPTED_WORKSPACE_ENVELOPE_VERSION,
    type: ENCRYPTED_WORKSPACE_ENVELOPE_TYPE,
    contextGraphId: fields.contextGraphId,
    senderIdentity: fields.senderIdentity,
    operationId: fields.operationId,
    shareOperationId: fields.shareOperationId,
    timestampMs: fields.timestampMs,
    subGraphName: fields.subGraphName ?? '',
    keyAgreementAlgorithm: fields.keyAgreementAlgorithm,
    ephemeralPublicKey: fields.ephemeralPublicKey,
  };
}

function computeRecipientKeyAAD(
  metadata: WorkspaceEncryptionMetadata,
  recipientId: string,
  recipientKeyId: string,
): Uint8Array {
  return concatBytes([
    computeEncryptedWorkspaceAAD(metadata),
    framedString('recipientId'),
    framedString(recipientId),
    framedString('recipientKeyId'),
    framedString(recipientKeyId),
  ]);
}

function deriveRecipientKeyWrapKey(sharedSecret: Uint8Array, recipientAAD: Uint8Array): Uint8Array {
  const key = hkdfSync(
    'sha256',
    Buffer.from(sharedSecret),
    Buffer.from(WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE),
    Buffer.from(recipientAAD),
    WORKSPACE_ENCRYPTION_KEY_BYTES,
  );
  return new Uint8Array(key);
}

async function aesGcmEncrypt(
  keyBytes: Uint8Array,
  plaintext: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const key = await importAesGcmKey(keyBytes, ['encrypt']);
  return new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
      key,
      plaintext,
    ),
  );
}

async function aesGcmDecrypt(
  keyBytes: Uint8Array,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const key = await importAesGcmKey(keyBytes, ['decrypt']);
  return new Uint8Array(
    await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
      key,
      ciphertext,
    ),
  );
}

async function importAesGcmKey(keyBytes: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  if (keyBytes.length !== WORKSPACE_ENCRYPTION_KEY_BYTES) {
    throw new Error('AES-GCM workspace key material must be 32 bytes');
  }
  return webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, usages);
}

function x25519SharedSecret(privateKeyBytes: Uint8Array, publicKeyBytes: Uint8Array): Uint8Array {
  assertX25519KeyBytes('privateEncryptionKey', privateKeyBytes);
  assertX25519KeyBytes('publicEncryptionKey', publicKeyBytes);
  return new Uint8Array(diffieHellman({
    privateKey: x25519PrivateKeyObject(privateKeyBytes),
    publicKey: x25519PublicKeyObject(publicKeyBytes),
  }));
}

function x25519PublicFromPrivate(privateKeyBytes: Uint8Array): Uint8Array {
  const spki = createPublicKey(x25519PrivateKeyObject(privateKeyBytes))
    .export({ format: 'der', type: 'spki' });
  return new Uint8Array(spki.subarray(spki.length - WORKSPACE_X25519_KEY_BYTES));
}

function x25519PrivateKeyObject(privateKeyBytes: Uint8Array): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b656e04220420', 'hex'),
      Buffer.from(privateKeyBytes),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
}

function x25519PublicKeyObject(publicKeyBytes: Uint8Array): KeyObject {
  return createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b656e032100', 'hex'),
      Buffer.from(publicKeyBytes),
    ]),
    format: 'der',
    type: 'spki',
  });
}

function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  webcrypto.getRandomValues(bytes);
  return bytes;
}

function checkedRandomBytes(length: number, randomBytes: (length: number) => Uint8Array): Uint8Array {
  const bytes = randomBytes(length);
  if (bytes.length !== length) {
    throw new Error(`randomBytes returned ${bytes.length} bytes, expected ${length}`);
  }
  return new Uint8Array(bytes);
}

function assertX25519KeyBytes(name: string, value: Uint8Array | undefined): asserts value is Uint8Array {
  if (!value || value.length !== WORKSPACE_X25519_KEY_BYTES) {
    throw new Error(`${name} must be 32 bytes`);
  }
}

function assertNonEmpty(name: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`${name} is required`);
  }
}

function padBase64(value: string): string {
  return value.padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
}

const textEncoder = new TextEncoder();

function uint32Be(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value, false);
  return buf;
}

function framedString(value: string): Uint8Array {
  const encoded = textEncoder.encode(value);
  return concatBytes([uint32Be(encoded.length), encoded]);
}

function framedBytes(value: Uint8Array): Uint8Array {
  return concatBytes([uint32Be(value.length), value]);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
