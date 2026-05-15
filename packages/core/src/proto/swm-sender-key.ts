/**
 * Protobuf wire schemas for Shared Working Memory Sender Key epochs.
 *
 * Sender Key setup packages are delivered over a direct libp2p protocol.
 * Sender Key messages are placed in the existing signed SWM GossipSub
 * envelope payload.
 *
 * @internal
 */
import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

export const SWM_SENDER_KEY_PACKAGE_VERSION = '1';
export const SWM_SENDER_KEY_PACKAGE_TYPE = 'swm.sender-key.package';
export const SWM_SENDER_KEY_PACKAGE_ACK_TYPE = 'swm.sender-key.package-ack';
export const SWM_SENDER_KEY_MESSAGE_TYPE = 'swm.sender-key.message';
export const SWM_SENDER_KEY_CIPHER_ALGORITHM = 'AES-256-GCM';
export const SWM_SENDER_KEY_SETUP_KEY_AGREEMENT_ALGORITHM = 'X25519-HKDF-SHA256';
export const SWM_SENDER_KEY_AAD_DOMAIN = 'dkg.swm.sender-key.aad.v1';
export const SWM_SENDER_KEY_SETUP_AAD_DOMAIN = 'dkg.swm.sender-key.setup-aad.v1';
export const SWM_SENDER_KEY_SIGNATURE_DOMAIN = 'dkg.swm.sender-key.signature.v1';

export const SwmSenderKeyPackageSchema = new Type('SwmSenderKeyPackage')
  .add(new Field('version', 1, 'string'))
  .add(new Field('type', 2, 'string'))
  .add(new Field('contextGraphId', 3, 'string'))
  .add(new Field('subGraphName', 4, 'string'))
  .add(new Field('senderAgentAddress', 5, 'string'))
  .add(new Field('epochId', 6, 'string'))
  .add(new Field('membershipHash', 7, 'string'))
  .add(new Field('recipientAgentAddress', 8, 'string'))
  .add(new Field('recipientKeyId', 9, 'string'))
  .add(new Field('createdAtMs', 10, 'uint64'))
  .add(new Field('initialMessageIndex', 11, 'uint64'))
  .add(new Field('senderSigningPublicKey', 12, 'bytes'))
  .add(new Field('keyAgreementAlgorithm', 13, 'string'))
  .add(new Field('ephemeralPublicKey', 14, 'bytes'))
  .add(new Field('nonce', 15, 'bytes'))
  .add(new Field('ciphertext', 16, 'bytes'))
  .add(new Field('signature', 17, 'bytes'));

export const SwmSenderKeyPackageAckSchema = new Type('SwmSenderKeyPackageAck')
  .add(new Field('version', 1, 'string'))
  .add(new Field('type', 2, 'string'))
  .add(new Field('accepted', 3, 'bool'))
  .add(new Field('reason', 4, 'string'))
  .add(new Field('contextGraphId', 5, 'string'))
  .add(new Field('subGraphName', 6, 'string'))
  .add(new Field('senderAgentAddress', 7, 'string'))
  .add(new Field('epochId', 8, 'string'))
  .add(new Field('membershipHash', 9, 'string'))
  .add(new Field('recipientAgentAddress', 10, 'string'));

export const SwmSenderKeyMessageSchema = new Type('SwmSenderKeyMessage')
  .add(new Field('version', 1, 'string'))
  .add(new Field('type', 2, 'string'))
  .add(new Field('contextGraphId', 3, 'string'))
  .add(new Field('subGraphName', 4, 'string'))
  .add(new Field('senderAgentAddress', 5, 'string'))
  .add(new Field('epochId', 6, 'string'))
  .add(new Field('membershipHash', 7, 'string'))
  .add(new Field('messageIndex', 8, 'uint64'))
  .add(new Field('cipherAlgorithm', 9, 'string'))
  .add(new Field('nonce', 10, 'bytes'))
  .add(new Field('ciphertext', 11, 'bytes'))
  .add(new Field('aadHash', 12, 'bytes'))
  .add(new Field('senderKeySignature', 13, 'bytes'));

export const SwmSenderKeySecretSchema = new Type('SwmSenderKeySecret')
  .add(new Field('contextGraphId', 1, 'string'))
  .add(new Field('subGraphName', 2, 'string'))
  .add(new Field('senderAgentAddress', 3, 'string'))
  .add(new Field('epochId', 4, 'string'))
  .add(new Field('membershipHash', 5, 'string'))
  .add(new Field('createdAtMs', 6, 'uint64'))
  .add(new Field('initialMessageIndex', 7, 'uint64'))
  .add(new Field('chainKey', 8, 'bytes'))
  .add(new Field('senderSigningPublicKey', 9, 'bytes'));

export interface SwmSenderKeyPackageMsg {
  version: string;
  type: string;
  contextGraphId: string;
  subGraphName?: string;
  senderAgentAddress: string;
  epochId: string;
  membershipHash: string;
  recipientAgentAddress: string;
  recipientKeyId: string;
  createdAtMs: number | bigint | LongLike;
  initialMessageIndex: number | bigint | LongLike;
  senderSigningPublicKey: Uint8Array;
  keyAgreementAlgorithm: string;
  ephemeralPublicKey: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  signature: Uint8Array;
}

export interface SwmSenderKeyPackageAckMsg {
  version: string;
  type: string;
  accepted: boolean;
  reason?: string;
  contextGraphId?: string;
  subGraphName?: string;
  senderAgentAddress?: string;
  epochId?: string;
  membershipHash?: string;
  recipientAgentAddress?: string;
}

export interface SwmSenderKeyMessageMsg {
  version: string;
  type: string;
  contextGraphId: string;
  subGraphName?: string;
  senderAgentAddress: string;
  epochId: string;
  membershipHash: string;
  messageIndex: number | bigint | LongLike;
  cipherAlgorithm: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  aadHash: Uint8Array;
  senderKeySignature: Uint8Array;
}

export interface SwmSenderKeySecretMsg {
  contextGraphId: string;
  subGraphName?: string;
  senderAgentAddress: string;
  epochId: string;
  membershipHash: string;
  createdAtMs: number | bigint | LongLike;
  initialMessageIndex: number | bigint | LongLike;
  chainKey: Uint8Array;
  senderSigningPublicKey: Uint8Array;
}

export interface SwmSenderKeyMessageAADFields {
  version?: string;
  type?: string;
  contextGraphId: string;
  subGraphName?: string;
  senderAgentAddress: string;
  epochId: string;
  membershipHash: string;
  messageIndex: number | bigint | LongLike;
  cipherAlgorithm?: string;
  nonce: Uint8Array;
}

export interface SwmSenderKeyPackageAADFields {
  version?: string;
  type?: string;
  contextGraphId: string;
  subGraphName?: string;
  senderAgentAddress: string;
  epochId: string;
  membershipHash: string;
  recipientAgentAddress: string;
  recipientKeyId: string;
  createdAtMs: number | bigint | LongLike;
  initialMessageIndex: number | bigint | LongLike;
  senderSigningPublicKey: Uint8Array;
  keyAgreementAlgorithm?: string;
  ephemeralPublicKey: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export interface LongLike {
  low: number;
  high: number;
  unsigned?: boolean;
}

export function encodeSwmSenderKeyPackage(msg: SwmSenderKeyPackageMsg): Uint8Array {
  return SwmSenderKeyPackageSchema.encode(
    SwmSenderKeyPackageSchema.create({
      ...msg,
      subGraphName: msg.subGraphName ?? '',
      createdAtMs: uint64ForProto(msg.createdAtMs),
      initialMessageIndex: uint64ForProto(msg.initialMessageIndex),
    }),
  ).finish();
}

export function decodeSwmSenderKeyPackage(buf: Uint8Array): SwmSenderKeyPackageMsg {
  const decoded = SwmSenderKeyPackageSchema.decode(buf) as unknown as Record<string, unknown>;
  return {
    version: stringField(decoded.version),
    type: stringField(decoded.type),
    contextGraphId: stringField(decoded.contextGraphId),
    subGraphName: stringField(decoded.subGraphName) || undefined,
    senderAgentAddress: stringField(decoded.senderAgentAddress),
    epochId: stringField(decoded.epochId),
    membershipHash: stringField(decoded.membershipHash),
    recipientAgentAddress: stringField(decoded.recipientAgentAddress),
    recipientKeyId: stringField(decoded.recipientKeyId),
    createdAtMs: uint64ForProto(decoded.createdAtMs ?? 0),
    initialMessageIndex: uint64ForProto(decoded.initialMessageIndex ?? 0),
    senderSigningPublicKey: bytesField(decoded.senderSigningPublicKey),
    keyAgreementAlgorithm: stringField(decoded.keyAgreementAlgorithm),
    ephemeralPublicKey: bytesField(decoded.ephemeralPublicKey),
    nonce: bytesField(decoded.nonce),
    ciphertext: bytesField(decoded.ciphertext),
    signature: bytesField(decoded.signature),
  };
}

export function encodeSwmSenderKeyPackageAck(msg: SwmSenderKeyPackageAckMsg): Uint8Array {
  return SwmSenderKeyPackageAckSchema.encode(
    SwmSenderKeyPackageAckSchema.create({
      ...msg,
      reason: msg.reason ?? '',
      contextGraphId: msg.contextGraphId ?? '',
      subGraphName: msg.subGraphName ?? '',
      senderAgentAddress: msg.senderAgentAddress ?? '',
      epochId: msg.epochId ?? '',
      membershipHash: msg.membershipHash ?? '',
      recipientAgentAddress: msg.recipientAgentAddress ?? '',
    }),
  ).finish();
}

export function decodeSwmSenderKeyPackageAck(buf: Uint8Array): SwmSenderKeyPackageAckMsg {
  const decoded = SwmSenderKeyPackageAckSchema.decode(buf) as unknown as Record<string, unknown>;
  return {
    version: stringField(decoded.version),
    type: stringField(decoded.type),
    accepted: Boolean(decoded.accepted),
    reason: stringField(decoded.reason) || undefined,
    contextGraphId: stringField(decoded.contextGraphId) || undefined,
    subGraphName: stringField(decoded.subGraphName) || undefined,
    senderAgentAddress: stringField(decoded.senderAgentAddress) || undefined,
    epochId: stringField(decoded.epochId) || undefined,
    membershipHash: stringField(decoded.membershipHash) || undefined,
    recipientAgentAddress: stringField(decoded.recipientAgentAddress) || undefined,
  };
}

export function encodeSwmSenderKeyMessage(msg: SwmSenderKeyMessageMsg): Uint8Array {
  return SwmSenderKeyMessageSchema.encode(
    SwmSenderKeyMessageSchema.create({
      ...msg,
      subGraphName: msg.subGraphName ?? '',
      messageIndex: uint64ForProto(msg.messageIndex),
    }),
  ).finish();
}

export function decodeSwmSenderKeyMessage(buf: Uint8Array): SwmSenderKeyMessageMsg {
  const decoded = SwmSenderKeyMessageSchema.decode(buf) as unknown as Record<string, unknown>;
  return {
    version: stringField(decoded.version),
    type: stringField(decoded.type),
    contextGraphId: stringField(decoded.contextGraphId),
    subGraphName: stringField(decoded.subGraphName) || undefined,
    senderAgentAddress: stringField(decoded.senderAgentAddress),
    epochId: stringField(decoded.epochId),
    membershipHash: stringField(decoded.membershipHash),
    messageIndex: uint64ForProto(decoded.messageIndex ?? 0),
    cipherAlgorithm: stringField(decoded.cipherAlgorithm),
    nonce: bytesField(decoded.nonce),
    ciphertext: bytesField(decoded.ciphertext),
    aadHash: bytesField(decoded.aadHash),
    senderKeySignature: bytesField(decoded.senderKeySignature),
  };
}

export function encodeSwmSenderKeySecret(msg: SwmSenderKeySecretMsg): Uint8Array {
  return SwmSenderKeySecretSchema.encode(
    SwmSenderKeySecretSchema.create({
      ...msg,
      subGraphName: msg.subGraphName ?? '',
      createdAtMs: uint64ForProto(msg.createdAtMs),
      initialMessageIndex: uint64ForProto(msg.initialMessageIndex),
    }),
  ).finish();
}

export function decodeSwmSenderKeySecret(buf: Uint8Array): SwmSenderKeySecretMsg {
  const decoded = SwmSenderKeySecretSchema.decode(buf) as unknown as Record<string, unknown>;
  return {
    contextGraphId: stringField(decoded.contextGraphId),
    subGraphName: stringField(decoded.subGraphName) || undefined,
    senderAgentAddress: stringField(decoded.senderAgentAddress),
    epochId: stringField(decoded.epochId),
    membershipHash: stringField(decoded.membershipHash),
    createdAtMs: uint64ForProto(decoded.createdAtMs ?? 0),
    initialMessageIndex: uint64ForProto(decoded.initialMessageIndex ?? 0),
    chainKey: bytesField(decoded.chainKey),
    senderSigningPublicKey: bytesField(decoded.senderSigningPublicKey),
  };
}

export function computeSwmSenderKeyMessageAAD(fields: SwmSenderKeyMessageAADFields): Uint8Array {
  return concatBytes([
    framedString('domain'),
    framedString(SWM_SENDER_KEY_AAD_DOMAIN),
    framedString('version'),
    framedString(fields.version ?? SWM_SENDER_KEY_PACKAGE_VERSION),
    framedString('type'),
    framedString(fields.type ?? SWM_SENDER_KEY_MESSAGE_TYPE),
    framedString('contextGraphId'),
    framedString(fields.contextGraphId),
    framedString('subGraphName'),
    framedString(fields.subGraphName ?? ''),
    framedString('senderAgentAddress'),
    framedString(fields.senderAgentAddress.toLowerCase()),
    framedString('epochId'),
    framedString(fields.epochId),
    framedString('membershipHash'),
    framedString(fields.membershipHash),
    framedString('messageIndex'),
    framedString(uint64ForAAD(fields.messageIndex)),
    framedString('cipherAlgorithm'),
    framedString(fields.cipherAlgorithm ?? SWM_SENDER_KEY_CIPHER_ALGORITHM),
    framedString('nonce'),
    framedBytes(fields.nonce),
  ]);
}

export function computeSwmSenderKeyPackageAAD(fields: SwmSenderKeyPackageAADFields): Uint8Array {
  return concatBytes([
    framedString('domain'),
    framedString(SWM_SENDER_KEY_SETUP_AAD_DOMAIN),
    framedString('version'),
    framedString(fields.version ?? SWM_SENDER_KEY_PACKAGE_VERSION),
    framedString('type'),
    framedString(fields.type ?? SWM_SENDER_KEY_PACKAGE_TYPE),
    framedString('contextGraphId'),
    framedString(fields.contextGraphId),
    framedString('subGraphName'),
    framedString(fields.subGraphName ?? ''),
    framedString('senderAgentAddress'),
    framedString(fields.senderAgentAddress.toLowerCase()),
    framedString('epochId'),
    framedString(fields.epochId),
    framedString('membershipHash'),
    framedString(fields.membershipHash),
    framedString('recipientAgentAddress'),
    framedString(fields.recipientAgentAddress.toLowerCase()),
    framedString('recipientKeyId'),
    framedString(fields.recipientKeyId),
    framedString('createdAtMs'),
    framedString(uint64ForAAD(fields.createdAtMs)),
    framedString('initialMessageIndex'),
    framedString(uint64ForAAD(fields.initialMessageIndex)),
    framedString('senderSigningPublicKey'),
    framedBytes(fields.senderSigningPublicKey),
    framedString('keyAgreementAlgorithm'),
    framedString(fields.keyAgreementAlgorithm ?? SWM_SENDER_KEY_SETUP_KEY_AGREEMENT_ALGORITHM),
    framedString('ephemeralPublicKey'),
    framedBytes(fields.ephemeralPublicKey),
    framedString('nonce'),
    framedBytes(fields.nonce),
    framedString('ciphertext'),
    framedBytes(fields.ciphertext),
  ]);
}

export function computeSwmSenderKeyPackageEncryptionAAD(
  fields: Omit<SwmSenderKeyPackageAADFields, 'ciphertext'>,
): Uint8Array {
  return concatBytes([
    framedString('domain'),
    framedString(`${SWM_SENDER_KEY_SETUP_AAD_DOMAIN}.encryption`),
    framedString('version'),
    framedString(fields.version ?? SWM_SENDER_KEY_PACKAGE_VERSION),
    framedString('type'),
    framedString(fields.type ?? SWM_SENDER_KEY_PACKAGE_TYPE),
    framedString('contextGraphId'),
    framedString(fields.contextGraphId),
    framedString('subGraphName'),
    framedString(fields.subGraphName ?? ''),
    framedString('senderAgentAddress'),
    framedString(fields.senderAgentAddress.toLowerCase()),
    framedString('epochId'),
    framedString(fields.epochId),
    framedString('membershipHash'),
    framedString(fields.membershipHash),
    framedString('recipientAgentAddress'),
    framedString(fields.recipientAgentAddress.toLowerCase()),
    framedString('recipientKeyId'),
    framedString(fields.recipientKeyId),
    framedString('createdAtMs'),
    framedString(uint64ForAAD(fields.createdAtMs)),
    framedString('initialMessageIndex'),
    framedString(uint64ForAAD(fields.initialMessageIndex)),
    framedString('senderSigningPublicKey'),
    framedBytes(fields.senderSigningPublicKey),
    framedString('keyAgreementAlgorithm'),
    framedString(fields.keyAgreementAlgorithm ?? SWM_SENDER_KEY_SETUP_KEY_AGREEMENT_ALGORITHM),
    framedString('ephemeralPublicKey'),
    framedBytes(fields.ephemeralPublicKey),
    framedString('nonce'),
    framedBytes(fields.nonce),
  ]);
}

export function computeSwmSenderKeySignaturePayload(
  aad: Uint8Array,
  aadHash: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  return concatBytes([
    framedString('domain'),
    framedString(SWM_SENDER_KEY_SIGNATURE_DOMAIN),
    framedString('aad'),
    framedBytes(aad),
    framedString('aadHash'),
    framedBytes(aadHash),
    framedString('ciphertext'),
    framedBytes(ciphertext),
  ]);
}

export function uint64ForAAD(value: number | bigint | LongLike): string {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new RangeError('uint64 value must be non-negative');
    return value.toString(10);
  }
  if (isLongLike(value)) {
    return longLikeToBigInt(value).toString(10);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('uint64 value must be a non-negative safe integer');
  }
  return String(value);
}

export function uint64ForProto(value: unknown): number {
  const asBigInt = typeof value === 'bigint'
    ? value
    : isLongLike(value)
      ? longLikeToBigInt(value)
      : BigInt(Number(value));
  if (asBigInt < 0n || asBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('uint64 value must fit in a non-negative safe integer');
  }
  return Number(asBigInt);
}

function isLongLike(value: unknown): value is LongLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'low' in value &&
    'high' in value &&
    typeof (value as LongLike).low === 'number' &&
    typeof (value as LongLike).high === 'number'
  );
}

function longLikeToBigInt(value: LongLike): bigint {
  if (!value.unsigned && value.high < 0) {
    throw new RangeError('uint64 value must be non-negative');
  }
  return (BigInt(value.high >>> 0) << 32n) + BigInt(value.low >>> 0);
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bytesField(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(0);
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
