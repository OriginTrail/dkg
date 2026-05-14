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
  const bytes = raw.startsWith('0x')
    ? Buffer.from(raw.slice(2), 'hex')
    : Buffer.from(padBase64(raw.replace(/-/g, '+').replace(/_/g, '/')), 'base64');
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
