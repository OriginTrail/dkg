import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  webcrypto,
  type KeyObject,
} from 'node:crypto';
import {
  SWM_SENDER_KEY_CIPHER_ALGORITHM,
  SWM_SENDER_KEY_MESSAGE_TYPE,
  SWM_SENDER_KEY_PACKAGE_TYPE,
  SWM_SENDER_KEY_PACKAGE_VERSION,
  SWM_SENDER_KEY_SETUP_KEY_AGREEMENT_ALGORITHM,
  computeSwmSenderKeyMessageAAD,
  computeSwmSenderKeyPackageAAD,
  computeSwmSenderKeyPackageEncryptionAAD,
  computeSwmSenderKeySignaturePayload,
  decodeSwmSenderKeySecret,
  encodeSwmSenderKeySecret,
  uint64ForProto,
  type SwmSenderKeyMessageAADFields,
  type SwmSenderKeyMessageMsg,
  type SwmSenderKeyPackageMsg,
  type SwmSenderKeySecretMsg,
} from '../proto/swm-sender-key.js';
import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_ENCRYPTION_KEY_BYTES,
  WORKSPACE_ENCRYPTION_NONCE_BYTES,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  WORKSPACE_X25519_KEY_BYTES,
  type WorkspaceRecipientEncryptionKey,
} from './workspace-encryption.js';
import { ed25519Sign, ed25519Verify } from './ed25519.js';

export const SWM_SENDER_KEY_CHAIN_KEY_BYTES = 32;
export const SWM_SENDER_KEY_SKIPPED_MESSAGE_CACHE_LIMIT = 64;
const SWM_SENDER_KEY_EPOCH_ID_BYTES = 16;
const SWM_SENDER_KEY_SETUP_KEY_PURPOSE = 'dkg.swm.sender-key.setup-key.v1';
const SWM_SENDER_KEY_PAYLOAD_KEY_PURPOSE = 'dkg.swm.sender-key.payload-key.v1';
const SWM_SENDER_KEY_NONCE_PURPOSE = 'dkg.swm.sender-key.nonce.v1';
const SWM_SENDER_KEY_CHAIN_RATCHET_PURPOSE = 'dkg.swm.sender-key.chain-ratchet.v1';
const SWM_SENDER_KEY_MEMBERSHIP_DOMAIN = 'dkg.swm.sender-key.membership.v1';

export interface SwmSenderKeyMembershipMember {
  agentAddress: string;
  recipientKeyId: string;
}

export interface ComputeSwmSenderKeyMembershipHashInput {
  contextGraphId: string;
  subGraphName?: string;
  members: readonly SwmSenderKeyMembershipMember[];
}

export interface EncryptSwmSenderKeyPackageInput {
  contextGraphId: string;
  subGraphName?: string;
  senderAgentAddress: string;
  epochId: string;
  membershipHash: string;
  recipientAgentAddress: string;
  recipientKeyId: string;
  createdAtMs: number;
  initialMessageIndex: number;
  chainKey: Uint8Array;
  senderSigningPublicKey: Uint8Array;
  recipientPublicKey: Uint8Array;
  randomBytes?: (length: number) => Uint8Array;
}

export interface DecryptSwmSenderKeyPackageInput {
  package: SwmSenderKeyPackageMsg;
  recipientKey: WorkspaceRecipientEncryptionKey;
}

export interface EncryptSwmSenderKeyMessageInput {
  chainKey: Uint8Array;
  plaintext: Uint8Array;
  senderSigningSecretKey: Uint8Array;
  contextGraphId: string;
  subGraphName?: string;
  senderAgentAddress: string;
  epochId: string;
  membershipHash: string;
  messageIndex: number;
}

export interface DecryptSwmSenderKeyMessageInput {
  chainKey: Uint8Array;
  message: SwmSenderKeyMessageMsg;
  senderSigningPublicKey: Uint8Array;
}

export interface SwmSenderKeyMessageCryptResult {
  message: SwmSenderKeyMessageMsg;
  plaintext?: Uint8Array;
  nextChainKey: Uint8Array;
}

export function generateSwmSenderChainKey(randomBytes?: (length: number) => Uint8Array): Uint8Array {
  return checkedRandomBytes(SWM_SENDER_KEY_CHAIN_KEY_BYTES, randomBytes ?? secureRandomBytes);
}

export function generateSwmSenderEpochId(randomBytes?: (length: number) => Uint8Array): string {
  return Buffer.from(checkedRandomBytes(SWM_SENDER_KEY_EPOCH_ID_BYTES, randomBytes ?? secureRandomBytes)).toString('hex');
}

export function computeSwmSenderKeyMembershipHash(
  input: ComputeSwmSenderKeyMembershipHashInput,
): string {
  assertNonEmpty('contextGraphId', input.contextGraphId);
  if (input.members.length === 0) {
    throw new Error('Sender Key membership requires at least one DKG agent recipient');
  }

  const framedMembers = input.members
    .map((member) => ({
      agentAddress: member.agentAddress.toLowerCase(),
      recipientKeyId: member.recipientKeyId,
    }))
    .sort((a, b) => {
      const byAgent = a.agentAddress.localeCompare(b.agentAddress);
      return byAgent !== 0 ? byAgent : a.recipientKeyId.localeCompare(b.recipientKeyId);
    })
    .flatMap((member) => [
      framedString('agentAddress'),
      framedString(member.agentAddress),
      framedString('recipientKeyId'),
      framedString(member.recipientKeyId),
    ]);

  const digest = createHash('sha256')
    .update(Buffer.from(concatBytes([
      framedString('domain'),
      framedString(SWM_SENDER_KEY_MEMBERSHIP_DOMAIN),
      framedString('contextGraphId'),
      framedString(input.contextGraphId),
      framedString('subGraphName'),
      framedString(input.subGraphName ?? ''),
      framedString('members'),
      ...framedMembers,
    ])))
    .digest('hex');
  return `sha256:${digest}`;
}

export async function encryptSwmSenderKeyPackage(
  input: EncryptSwmSenderKeyPackageInput,
): Promise<SwmSenderKeyPackageMsg> {
  assertChainKey(input.chainKey);
  assertX25519KeyBytes('recipientPublicKey', input.recipientPublicKey);
  assertNonEmpty('recipientKeyId', input.recipientKeyId);
  assertNonEmpty('senderAgentAddress', input.senderAgentAddress);
  assertNonEmpty('recipientAgentAddress', input.recipientAgentAddress);
  assertNonEmpty('epochId', input.epochId);
  assertNonEmpty('membershipHash', input.membershipHash);

  const randomBytes = input.randomBytes ?? secureRandomBytes;
  const ephemeralPrivateKey = checkedRandomBytes(WORKSPACE_X25519_KEY_BYTES, randomBytes);
  const ephemeralPublicKey = x25519PublicFromPrivate(ephemeralPrivateKey);
  const nonce = checkedRandomBytes(WORKSPACE_ENCRYPTION_NONCE_BYTES, randomBytes);
  const secret: SwmSenderKeySecretMsg = {
    contextGraphId: input.contextGraphId,
    subGraphName: input.subGraphName,
    senderAgentAddress: input.senderAgentAddress,
    epochId: input.epochId,
    membershipHash: input.membershipHash,
    createdAtMs: input.createdAtMs,
    initialMessageIndex: input.initialMessageIndex,
    chainKey: input.chainKey,
    senderSigningPublicKey: input.senderSigningPublicKey,
  };
  const packageAADFields = {
    version: SWM_SENDER_KEY_PACKAGE_VERSION,
    type: SWM_SENDER_KEY_PACKAGE_TYPE,
    contextGraphId: input.contextGraphId,
    subGraphName: input.subGraphName,
    senderAgentAddress: input.senderAgentAddress,
    epochId: input.epochId,
    membershipHash: input.membershipHash,
    recipientAgentAddress: input.recipientAgentAddress,
    recipientKeyId: input.recipientKeyId,
    createdAtMs: input.createdAtMs,
    initialMessageIndex: input.initialMessageIndex,
    senderSigningPublicKey: input.senderSigningPublicKey,
    keyAgreementAlgorithm: SWM_SENDER_KEY_SETUP_KEY_AGREEMENT_ALGORITHM,
    ephemeralPublicKey,
    nonce,
  };
  const aad = computeSwmSenderKeyPackageEncryptionAAD(packageAADFields);
  const setupKey = deriveSetupKey(
    x25519SharedSecret(ephemeralPrivateKey, input.recipientPublicKey),
    aad,
  );
  const ciphertext = await aesGcmEncrypt(setupKey, encodeSwmSenderKeySecret(secret), nonce, aad);

  return {
    ...packageAADFields,
    ciphertext,
    signature: new Uint8Array(0),
  };
}

export async function decryptSwmSenderKeyPackage(
  input: DecryptSwmSenderKeyPackageInput,
): Promise<SwmSenderKeySecretMsg> {
  assertSupportedSwmSenderKeyPackage(input.package);
  validateRecipientEncryptionKey(input.recipientKey, 'decrypt');
  if (
    input.recipientKey.recipientKeyId !== input.package.recipientKeyId ||
    input.recipientKey.recipientId.toLowerCase() !== `did:dkg:agent:${input.package.recipientAgentAddress}`.toLowerCase()
  ) {
    throw new Error('Sender Key setup package recipient does not match local encryption key');
  }
  const aad = computeSwmSenderKeyPackageEncryptionAAD(input.package);
  const setupKey = deriveSetupKey(
    x25519SharedSecret(input.recipientKey.privateKeyBytes!, input.package.ephemeralPublicKey),
    aad,
  );
  const plaintext = await aesGcmDecrypt(setupKey, input.package.ciphertext, input.package.nonce, aad);
  const secret = decodeSwmSenderKeySecret(plaintext);
  assertChainKey(secret.chainKey);

  if (
    secret.contextGraphId !== input.package.contextGraphId ||
    (secret.subGraphName ?? '') !== (input.package.subGraphName ?? '') ||
    secret.senderAgentAddress.toLowerCase() !== input.package.senderAgentAddress.toLowerCase() ||
    secret.epochId !== input.package.epochId ||
    secret.membershipHash !== input.package.membershipHash ||
    uint64ForProto(secret.createdAtMs) !== uint64ForProto(input.package.createdAtMs) ||
    uint64ForProto(secret.initialMessageIndex) !== uint64ForProto(input.package.initialMessageIndex) ||
    !equalBytes(secret.senderSigningPublicKey, input.package.senderSigningPublicKey)
  ) {
    throw new Error('Sender Key setup package secret metadata does not match package metadata');
  }

  return secret;
}

export async function encryptSwmSenderKeyMessage(
  input: EncryptSwmSenderKeyMessageInput,
): Promise<SwmSenderKeyMessageCryptResult> {
  assertChainKey(input.chainKey);
  assertNonEmpty('contextGraphId', input.contextGraphId);
  assertNonEmpty('senderAgentAddress', input.senderAgentAddress);
  assertNonEmpty('epochId', input.epochId);
  assertNonEmpty('membershipHash', input.membershipHash);

  const nonce = deriveMessageNonce(input.chainKey, input);
  const aadFields: SwmSenderKeyMessageAADFields = {
    version: SWM_SENDER_KEY_PACKAGE_VERSION,
    type: SWM_SENDER_KEY_MESSAGE_TYPE,
    contextGraphId: input.contextGraphId,
    subGraphName: input.subGraphName,
    senderAgentAddress: input.senderAgentAddress,
    epochId: input.epochId,
    membershipHash: input.membershipHash,
    messageIndex: input.messageIndex,
    cipherAlgorithm: SWM_SENDER_KEY_CIPHER_ALGORITHM,
    nonce,
  };
  const aad = computeSwmSenderKeyMessageAAD(aadFields);
  const payloadKey = derivePayloadKey(input.chainKey, aad);
  const ciphertext = await aesGcmEncrypt(payloadKey, input.plaintext, nonce, aad);
  const aadHash = sha256Bytes(aad);
  const senderKeySignature = await ed25519Sign(
    computeSwmSenderKeySignaturePayload(aad, aadHash, ciphertext),
    input.senderSigningSecretKey,
  );

  return {
    message: {
      version: SWM_SENDER_KEY_PACKAGE_VERSION,
      type: SWM_SENDER_KEY_MESSAGE_TYPE,
      contextGraphId: input.contextGraphId,
      subGraphName: input.subGraphName,
      senderAgentAddress: input.senderAgentAddress,
      epochId: input.epochId,
      membershipHash: input.membershipHash,
      messageIndex: input.messageIndex,
      cipherAlgorithm: SWM_SENDER_KEY_CIPHER_ALGORITHM,
      nonce,
      ciphertext,
      aadHash,
      senderKeySignature,
    },
    nextChainKey: ratchetSwmSenderChainKey(input.chainKey),
  };
}

export async function decryptSwmSenderKeyMessage(
  input: DecryptSwmSenderKeyMessageInput,
): Promise<SwmSenderKeyMessageCryptResult & { plaintext: Uint8Array }> {
  assertChainKey(input.chainKey);
  assertSupportedSwmSenderKeyMessage(input.message);

  const expectedNonce = deriveMessageNonce(input.chainKey, {
    contextGraphId: input.message.contextGraphId,
    subGraphName: input.message.subGraphName,
    senderAgentAddress: input.message.senderAgentAddress,
    epochId: input.message.epochId,
    membershipHash: input.message.membershipHash,
    messageIndex: uint64ForProto(input.message.messageIndex),
  });
  if (!equalBytes(expectedNonce, input.message.nonce)) {
    throw new Error('Sender Key message nonce does not match ratchet state');
  }

  const aad = computeSwmSenderKeyMessageAAD(input.message);
  const aadHash = sha256Bytes(aad);
  if (!equalBytes(aadHash, input.message.aadHash)) {
    throw new Error('Sender Key message AAD hash mismatch');
  }

  const signatureOk = await ed25519Verify(
    input.message.senderKeySignature,
    computeSwmSenderKeySignaturePayload(aad, aadHash, input.message.ciphertext),
    input.senderSigningPublicKey,
  );
  if (!signatureOk) {
    throw new Error('Invalid Sender Key epoch signature');
  }

  const payloadKey = derivePayloadKey(input.chainKey, aad);
  const plaintext = await aesGcmDecrypt(payloadKey, input.message.ciphertext, input.message.nonce, aad);
  return {
    message: input.message,
    plaintext,
    nextChainKey: ratchetSwmSenderChainKey(input.chainKey),
  };
}

export function ratchetSwmSenderChainKey(chainKey: Uint8Array): Uint8Array {
  assertChainKey(chainKey);
  return new Uint8Array(createHmac('sha256', Buffer.from(chainKey))
    .update(SWM_SENDER_KEY_CHAIN_RATCHET_PURPOSE)
    .digest());
}

export function assertSupportedSwmSenderKeyPackage(pkg: SwmSenderKeyPackageMsg): void {
  if (pkg.version !== SWM_SENDER_KEY_PACKAGE_VERSION) {
    throw new Error(`Unsupported Sender Key package version: ${pkg.version}`);
  }
  if (pkg.type !== SWM_SENDER_KEY_PACKAGE_TYPE) {
    throw new Error(`Unsupported Sender Key package type: ${pkg.type}`);
  }
  if (pkg.keyAgreementAlgorithm !== SWM_SENDER_KEY_SETUP_KEY_AGREEMENT_ALGORITHM) {
    throw new Error(`Unsupported Sender Key setup key agreement algorithm: ${pkg.keyAgreementAlgorithm}`);
  }
  assertX25519KeyBytes('Sender Key setup ephemeral public key', pkg.ephemeralPublicKey);
  assertNonce(pkg.nonce, 'Sender Key setup nonce');
  if (pkg.ciphertext.length === 0) {
    throw new Error('Sender Key setup ciphertext is empty');
  }
  if (pkg.senderSigningPublicKey.length !== 32) {
    throw new Error('Sender Key epoch signing public key must be 32 bytes');
  }
}

export function assertSupportedSwmSenderKeyMessage(message: SwmSenderKeyMessageMsg): void {
  if (message.version !== SWM_SENDER_KEY_PACKAGE_VERSION) {
    throw new Error(`Unsupported Sender Key message version: ${message.version}`);
  }
  if (message.type !== SWM_SENDER_KEY_MESSAGE_TYPE) {
    throw new Error(`Unsupported Sender Key message type: ${message.type}`);
  }
  if (message.cipherAlgorithm !== SWM_SENDER_KEY_CIPHER_ALGORITHM) {
    throw new Error(`Unsupported Sender Key cipher algorithm: ${message.cipherAlgorithm}`);
  }
  assertNonce(message.nonce, 'Sender Key message nonce');
  if (message.ciphertext.length === 0) {
    throw new Error('Sender Key message ciphertext is empty');
  }
  if (message.aadHash.length !== 32) {
    throw new Error('Sender Key message AAD hash must be 32 bytes');
  }
  if (message.senderKeySignature.length !== 64) {
    throw new Error('Sender Key message signature must be 64 bytes');
  }
}

function deriveMessageNonce(
  chainKey: Uint8Array,
  fields: Omit<EncryptSwmSenderKeyMessageInput, 'chainKey' | 'plaintext' | 'senderSigningSecretKey'>,
): Uint8Array {
  const aadWithoutNonce = computeSwmSenderKeyMessageAAD({
    version: SWM_SENDER_KEY_PACKAGE_VERSION,
    type: SWM_SENDER_KEY_MESSAGE_TYPE,
    contextGraphId: fields.contextGraphId,
    subGraphName: fields.subGraphName,
    senderAgentAddress: fields.senderAgentAddress,
    epochId: fields.epochId,
    membershipHash: fields.membershipHash,
    messageIndex: fields.messageIndex,
    cipherAlgorithm: SWM_SENDER_KEY_CIPHER_ALGORITHM,
    nonce: new Uint8Array(0),
  });
  return new Uint8Array(hkdfSync(
    'sha256',
    Buffer.from(chainKey),
    Buffer.from(SWM_SENDER_KEY_NONCE_PURPOSE),
    Buffer.from(aadWithoutNonce),
    WORKSPACE_ENCRYPTION_NONCE_BYTES,
  ));
}

function derivePayloadKey(chainKey: Uint8Array, aad: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync(
    'sha256',
    Buffer.from(chainKey),
    Buffer.from(SWM_SENDER_KEY_PAYLOAD_KEY_PURPOSE),
    Buffer.from(aad),
    WORKSPACE_ENCRYPTION_KEY_BYTES,
  ));
}

function deriveSetupKey(sharedSecret: Uint8Array, aad: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync(
    'sha256',
    Buffer.from(sharedSecret),
    Buffer.from(SWM_SENDER_KEY_SETUP_KEY_PURPOSE),
    Buffer.from(aad),
    WORKSPACE_ENCRYPTION_KEY_BYTES,
  ));
}

async function aesGcmEncrypt(
  keyBytes: Uint8Array,
  plaintext: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const key = await importAesGcmKey(keyBytes, ['encrypt']);
  return new Uint8Array(await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
    key,
    plaintext,
  ));
}

async function aesGcmDecrypt(
  keyBytes: Uint8Array,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const key = await importAesGcmKey(keyBytes, ['decrypt']);
  return new Uint8Array(await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
    key,
    ciphertext,
  ));
}

async function importAesGcmKey(keyBytes: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  if (keyBytes.length !== WORKSPACE_ENCRYPTION_KEY_BYTES) {
    throw new Error('AES-GCM Sender Key material must be 32 bytes');
  }
  return webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, usages);
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
    assertX25519KeyBytes('publicEncryptionKey', key.publicKeyBytes);
  } else {
    assertX25519KeyBytes('privateEncryptionKey', key.privateKeyBytes);
  }
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

function assertChainKey(value: Uint8Array): void {
  if (value.length !== SWM_SENDER_KEY_CHAIN_KEY_BYTES) {
    throw new Error('Sender Key chain key must be 32 bytes');
  }
}

function assertNonce(value: Uint8Array, name: string): void {
  if (value.length !== WORKSPACE_ENCRYPTION_NONCE_BYTES) {
    throw new Error(`${name} must be 12 bytes`);
  }
}

function assertNonEmpty(name: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`${name} is required`);
  }
}

function sha256Bytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(Buffer.from(value)).digest());
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
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
