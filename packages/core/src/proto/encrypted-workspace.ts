/**
 * Protobuf wire schemas for encrypted Shared Working Memory workspace payloads.
 *
 * This schema is intentionally separate from `GossipEnvelope` and
 * `WorkspacePublishRequest`: encrypted SWM gossip can place this message in an
 * existing gossip envelope payload without changing either legacy wire format.
 *
 * @internal
 */
import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

export const ENCRYPTED_WORKSPACE_ENVELOPE_VERSION = '1';
export const ENCRYPTED_WORKSPACE_ENVELOPE_TYPE = 'dkg.workspace.encrypted';
export const ENCRYPTED_WORKSPACE_CIPHER_ALGORITHM = 'AES-256-GCM';
export const ENCRYPTED_WORKSPACE_KEY_AGREEMENT_ALGORITHM = 'X25519-HKDF-SHA256';
export const ENCRYPTED_WORKSPACE_KEY_WRAP_ALGORITHM = 'AES-256-GCM';
export const ENCRYPTED_WORKSPACE_AAD_DOMAIN = 'dkg.workspace.encrypted.aad.v1';

export const EncryptedWorkspaceRecipientKeySlotSchema = new Type('EncryptedWorkspaceRecipientKeySlot')
  .add(new Field('recipientId', 1, 'string'))
  .add(new Field('recipientKeyId', 2, 'string'))
  .add(new Field('algorithm', 3, 'string'))
  .add(new Field('nonce', 4, 'bytes'))
  .add(new Field('encryptedKey', 5, 'bytes'));

export const EncryptedWorkspacePayloadSchema = new Type('EncryptedWorkspacePayload')
  .add(new Field('version', 1, 'string'))
  .add(new Field('type', 2, 'string'))
  .add(new Field('contextGraphId', 3, 'string'))
  .add(new Field('senderIdentity', 4, 'string'))
  .add(new Field('operationId', 5, 'string'))
  .add(new Field('workspaceOperationId', 6, 'string'))
  .add(new Field('timestampMs', 7, 'uint64'))
  .add(new Field('subGraphName', 8, 'string'))
  .add(new Field('cipherAlgorithm', 9, 'string'))
  .add(new Field('nonce', 10, 'bytes'))
  .add(new Field('ciphertext', 11, 'bytes'))
  .add(new Field('recipients', 12, 'EncryptedWorkspaceRecipientKeySlot', 'repeated'))
  .add(new Field('keyAgreementAlgorithm', 13, 'string'))
  .add(new Field('ephemeralPublicKey', 14, 'bytes'))
  .add(EncryptedWorkspaceRecipientKeySlotSchema);

export interface EncryptedWorkspaceRecipientKeySlotMsg {
  recipientId: string;
  recipientKeyId: string;
  algorithm: string;
  nonce: Uint8Array;
  encryptedKey: Uint8Array;
}

export interface EncryptedWorkspacePayloadMsg {
  version: string;
  type: string;
  contextGraphId: string;
  senderIdentity: string;
  operationId: string;
  workspaceOperationId: string;
  timestampMs: number | bigint | LongLike;
  subGraphName?: string;
  cipherAlgorithm: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  recipients: EncryptedWorkspaceRecipientKeySlotMsg[];
  keyAgreementAlgorithm: string;
  ephemeralPublicKey: Uint8Array;
}

export interface EncryptedWorkspaceAADFields {
  version?: string;
  type?: string;
  contextGraphId: string;
  senderIdentity: string;
  operationId: string;
  workspaceOperationId: string;
  timestampMs: number | bigint | LongLike;
  subGraphName?: string;
  keyAgreementAlgorithm?: string;
  ephemeralPublicKey?: Uint8Array;
}

export interface LongLike {
  low: number;
  high: number;
  unsigned?: boolean;
}

export function encodeEncryptedWorkspacePayload(msg: EncryptedWorkspacePayloadMsg): Uint8Array {
  return EncryptedWorkspacePayloadSchema.encode(
    EncryptedWorkspacePayloadSchema.create({
      ...msg,
      timestampMs: timestampForProto(msg.timestampMs),
      subGraphName: msg.subGraphName ?? '',
      recipients: msg.recipients ?? [],
      keyAgreementAlgorithm: msg.keyAgreementAlgorithm,
      ephemeralPublicKey: msg.ephemeralPublicKey,
    }),
  ).finish();
}

export function decodeEncryptedWorkspacePayload(buf: Uint8Array): EncryptedWorkspacePayloadMsg {
  const decoded = EncryptedWorkspacePayloadSchema.decode(buf) as unknown as Record<string, unknown>;
  return {
    version: stringField(decoded.version),
    type: stringField(decoded.type),
    contextGraphId: stringField(decoded.contextGraphId),
    senderIdentity: stringField(decoded.senderIdentity),
    operationId: stringField(decoded.operationId),
    workspaceOperationId: stringField(decoded.workspaceOperationId),
    timestampMs: timestampForProto(decoded.timestampMs ?? 0),
    subGraphName: stringField(decoded.subGraphName) || undefined,
    cipherAlgorithm: stringField(decoded.cipherAlgorithm),
    nonce: bytesField(decoded.nonce),
    ciphertext: bytesField(decoded.ciphertext),
    recipients: Array.isArray(decoded.recipients)
      ? decoded.recipients.map((slot) => {
        const record = slot as Record<string, unknown>;
        return {
          recipientId: stringField(record.recipientId),
          recipientKeyId: stringField(record.recipientKeyId),
          algorithm: stringField(record.algorithm),
          nonce: bytesField(record.nonce),
          encryptedKey: bytesField(record.encryptedKey),
        };
      })
      : [],
    keyAgreementAlgorithm: stringField(decoded.keyAgreementAlgorithm),
    ephemeralPublicKey: bytesField(decoded.ephemeralPublicKey),
  };
}

/**
 * Build deterministic authenticated data for encrypted workspace payloads.
 *
 * The exact field set binds ciphertext authentication to the context graph,
 * envelope type/version, sender identity, operation IDs, timestamp, and
 * optional sub-graph target. Receivers must recompute this from decoded
 * metadata instead of trusting caller-supplied bytes.
 */
export function computeEncryptedWorkspaceAAD(fields: EncryptedWorkspaceAADFields): Uint8Array {
  return concatBytes([
    framedString('domain'),
    framedString(ENCRYPTED_WORKSPACE_AAD_DOMAIN),
    framedString('version'),
    framedString(fields.version ?? ENCRYPTED_WORKSPACE_ENVELOPE_VERSION),
    framedString('type'),
    framedString(fields.type ?? ENCRYPTED_WORKSPACE_ENVELOPE_TYPE),
    framedString('contextGraphId'),
    framedString(fields.contextGraphId),
    framedString('senderIdentity'),
    framedString(fields.senderIdentity),
    framedString('operationId'),
    framedString(fields.operationId),
    framedString('workspaceOperationId'),
    framedString(fields.workspaceOperationId),
    framedString('timestampMs'),
    framedString(timestampForAAD(fields.timestampMs)),
    framedString('subGraphName'),
    framedString(fields.subGraphName ?? ''),
    framedString('keyAgreementAlgorithm'),
    framedString(fields.keyAgreementAlgorithm ?? ''),
    framedString('ephemeralPublicKey'),
    framedBytes(fields.ephemeralPublicKey ?? new Uint8Array()),
  ]);
}

export function timestampForAAD(value: number | bigint | LongLike): string {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new RangeError('timestampMs must be non-negative');
    }
    return value.toString(10);
  }
  if (isLongLike(value)) {
    return longLikeToBigInt(value).toString(10);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('timestampMs must be a non-negative safe integer');
  }
  return String(value);
}

function timestampForProto(value: unknown): number {
  const asBigInt = typeof value === 'bigint'
    ? value
    : isLongLike(value)
      ? longLikeToBigInt(value)
      : BigInt(Number(value));
  if (asBigInt < 0n || asBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('timestampMs must fit in a non-negative safe integer');
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
    throw new RangeError('timestampMs must be non-negative');
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
