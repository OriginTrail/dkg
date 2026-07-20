import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { decodeProtocolTuple, encodeProtocolTuple } from '../protocol/codec.js';
import { hashCanonicalTupleV1 } from '../protocol/hashes.js';
import { WAL_V1_ENUMS, type ProtocolTuple } from '../protocol/schema.js';
import { privatePayloadError, WalPrivatePayloadError } from './errors.js';
import type {
  DecryptPrivateDkgPayloadInput,
  DkgPayloadMetadata,
  EncodedDkgPayloadEnvelope,
  EncodePublicDkgPayloadInput,
  EncryptPrivateDkgPayloadInput,
  WalPayloadCoordinates,
} from './types.js';

const AES_256_GCM = BigInt(WAL_V1_ENUMS.encryptionAlgorithm.AES_256_GCM);
const MOVE_TIER_SOURCE = BigInt(WAL_V1_ENUMS.payloadKind.MOVE_TIER_SOURCE);
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_MEDIA_TYPE_BYTES = 128;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;
const OBJECT_KEY_INFO_DOMAIN = new TextEncoder().encode('dkg-wal-private-object-v1\0');
const textEncoder = new TextEncoder();

function copy(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function bytes(value: Uint8Array, length: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    privatePayloadError('WAL_PRIVATE_INVALID', `${name} must be exactly ${length} bytes`);
  }
  return copy(value);
}

function variableBytes(value: Uint8Array, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) privatePayloadError('WAL_PRIVATE_INVALID', `${name} must be bytes`);
  return copy(value);
}

function u64(value: bigint, name: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_U64) {
    privatePayloadError('WAL_PRIVATE_INVALID', `${name} must be an unsigned 64-bit integer`);
  }
  return value;
}

function u64be(value: bigint, name: string): Uint8Array {
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, u64(value, name), false);
  return output;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function metadata(input: DkgPayloadMetadata): DkgPayloadMetadata {
  const mediaType = input.mediaType;
  if (
    typeof mediaType !== 'string'
    || mediaType.normalize('NFC') !== mediaType
    || textEncoder.encode(mediaType).length > MAX_MEDIA_TYPE_BYTES
  ) privatePayloadError('WAL_PRIVATE_INVALID', 'mediaType must be NFC text of at most 128 UTF-8 bytes');
  return {
    payloadKind: u64(input.payloadKind, 'payloadKind'),
    codec: u64(input.codec, 'codec'),
    mediaType,
  };
}

function coordinates(input: WalPayloadCoordinates): WalPayloadCoordinates {
  return {
    namespaceId: bytes(input.namespaceId, 32, 'namespaceId'),
    writerId: bytes(input.writerId, 20, 'writerId'),
    writerEpoch: u64(input.writerEpoch, 'writerEpoch'),
    sequence: u64(input.sequence, 'sequence'),
  };
}

export function derivePrivateObjectKey(
  epochKey: Uint8Array,
  input: WalPayloadCoordinates,
): Uint8Array {
  const key = bytes(epochKey, KEY_BYTES, 'epochKey');
  const exact = coordinates(input);
  const salt = concat(exact.writerId, u64be(exact.writerEpoch, 'writerEpoch'));
  const info = concat(OBJECT_KEY_INFO_DOMAIN, exact.namespaceId, u64be(exact.sequence, 'sequence'));
  return new Uint8Array(hkdfSync('sha256', key, salt, info, KEY_BYTES));
}

export function privatePayloadAssociatedDataDigest(
  input: WalPayloadCoordinates & DkgPayloadMetadata & { keyEpoch: bigint; nonce: Uint8Array },
): Uint8Array {
  const exact = coordinates(input);
  const fields = metadata(input);
  const keyEpoch = u64(input.keyEpoch, 'keyEpoch');
  const nonce = bytes(input.nonce, NONCE_BYTES, 'nonce');
  return hashCanonicalTupleV1('payloadAssociatedData', [
    exact.namespaceId,
    exact.writerId,
    exact.writerEpoch,
    exact.sequence,
    1n,
    fields.payloadKind,
    fields.codec,
    fields.mediaType,
    keyEpoch,
    nonce,
  ]);
}

export function encodePublicDkgPayload(input: EncodePublicDkgPayloadInput): EncodedDkgPayloadEnvelope {
  const fields = metadata(input);
  if (fields.payloadKind === MOVE_TIER_SOURCE) {
    privatePayloadError('WAL_PRIVATE_DOWNGRADE', 'MOVE_TIER_SOURCE payloads cannot be public');
  }
  const tuple: ProtocolTuple<'DkgPayloadEnvelopeV1'> = [
    1n,
    fields.payloadKind,
    fields.codec,
    fields.mediaType,
    null,
    variableBytes(input.contentBytes, 'contentBytes'),
  ];
  return { tuple, canonicalBytes: encodeProtocolTuple('DkgPayloadEnvelopeV1', tuple) };
}

export function encryptPrivateDkgPayload(
  input: EncryptPrivateDkgPayloadInput,
): EncodedDkgPayloadEnvelope {
  const exact = coordinates(input);
  const fields = metadata(input);
  const keyEpoch = u64(input.keyEpoch, 'keyEpoch');
  const plaintext = variableBytes(input.plaintext, 'plaintext');
  const nonce = input.nonce === undefined
    ? new Uint8Array(randomBytes(NONCE_BYTES))
    : bytes(input.nonce, NONCE_BYTES, 'nonce');
  if (!input.nonceRegistry || typeof input.nonceRegistry.claimPrivatePayloadNonce !== 'function') {
    privatePayloadError('WAL_PRIVATE_INVALID', 'a durable private-payload nonce registry is required');
  }
  const objectKey = derivePrivateObjectKey(input.epochKey, exact);
  const associatedDataDigest = privatePayloadAssociatedDataDigest({ ...exact, ...fields, keyEpoch, nonce });
  try {
    input.nonceRegistry.claimPrivatePayloadNonce({ ...exact, keyEpoch, nonce });
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'WAL_CONTROL_NONCE_REUSE') {
      return privatePayloadError('WAL_PRIVATE_NONCE_REUSE', 'private payload nonce reuse rejected', error);
    }
    throw error;
  }
  const cipher = createCipheriv('aes-256-gcm', objectKey, nonce);
  cipher.setAAD(associatedDataDigest);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const descriptor: ProtocolTuple<'EncryptionDescriptorV1'> = [
    AES_256_GCM,
    keyEpoch,
    nonce,
    associatedDataDigest,
  ];
  const tuple: ProtocolTuple<'DkgPayloadEnvelopeV1'> = [
    1n,
    fields.payloadKind,
    fields.codec,
    fields.mediaType,
    descriptor,
    new Uint8Array(ciphertext),
  ];
  return { tuple, canonicalBytes: encodeProtocolTuple('DkgPayloadEnvelopeV1', tuple) };
}

export function decodeDkgPayloadEnvelope(envelopeBytes: Uint8Array): ProtocolTuple<'DkgPayloadEnvelopeV1'> {
  if (!(envelopeBytes instanceof Uint8Array) || envelopeBytes.length === 0) {
    privatePayloadError('WAL_PRIVATE_INVALID', 'payload envelope bytes cannot be empty');
  }
  try {
    const tuple = decodeProtocolTuple('DkgPayloadEnvelopeV1', envelopeBytes);
    metadata({ payloadKind: tuple[1], codec: tuple[2], mediaType: tuple[3] });
    return tuple;
  } catch (error) {
    if (error instanceof WalPrivatePayloadError) throw error;
    return privatePayloadError('WAL_PRIVATE_INVALID', 'invalid canonical DkgPayloadEnvelopeV1', error);
  }
}

export function decryptPrivateDkgPayload(input: DecryptPrivateDkgPayloadInput): Uint8Array {
  const exact = coordinates(input);
  const tuple = decodeDkgPayloadEnvelope(input.envelopeBytes);
  const descriptor = tuple[4];
  if (descriptor === null) privatePayloadError('WAL_PRIVATE_DOWNGRADE', 'private payload envelope is unencrypted');
  const expected = [
    [input.expectedKeyEpoch, descriptor[1], 'key epoch'],
    [input.expectedPayloadKind, tuple[1], 'payload kind'],
    [input.expectedCodec, tuple[2], 'codec'],
  ] as const;
  for (const [wanted, actual, name] of expected) {
    if (wanted !== actual) {
      privatePayloadError('WAL_PRIVATE_AUTH_FAILED', `private payload ${name} mismatch`);
    }
  }
  if (input.expectedMediaType !== tuple[3]) {
    privatePayloadError('WAL_PRIVATE_AUTH_FAILED', 'private payload media type mismatch');
  }
  const digest = privatePayloadAssociatedDataDigest({
    ...exact,
    payloadKind: tuple[1],
    codec: tuple[2],
    mediaType: tuple[3],
    keyEpoch: descriptor[1],
    nonce: descriptor[2],
  });
  if (!equal(digest, descriptor[3])) {
    privatePayloadError('WAL_PRIVATE_AUTH_FAILED', 'private payload associated-data binding mismatch');
  }
  if (tuple[5].length < TAG_BYTES) privatePayloadError('WAL_PRIVATE_AUTH_FAILED', 'private payload authentication tag is missing');
  try {
    const objectKey = derivePrivateObjectKey(input.epochKey, exact);
    const ciphertext = tuple[5].subarray(0, -TAG_BYTES);
    const tag = tuple[5].subarray(-TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', objectKey, descriptor[2]);
    decipher.setAAD(digest);
    decipher.setAuthTag(tag);
    const plaintext = new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    if (input.validatePlaintext !== undefined && !input.validatePlaintext(copy(plaintext))) {
      privatePayloadError('WAL_PRIVATE_AUTH_FAILED', 'private payload semantic binding mismatch');
    }
    return plaintext;
  } catch (error) {
    if (error instanceof WalPrivatePayloadError) throw error;
    return privatePayloadError('WAL_PRIVATE_AUTH_FAILED', 'private payload authentication failed', error);
  }
}

export function requirePayloadVisibility(
  envelopeBytes: Uint8Array,
  visibility: 'public' | 'private',
): ProtocolTuple<'DkgPayloadEnvelopeV1'> {
  const tuple = decodeDkgPayloadEnvelope(envelopeBytes);
  if (visibility === 'private' && tuple[4] === null) {
    privatePayloadError('WAL_PRIVATE_DOWNGRADE', 'private view cannot consume a plaintext payload');
  }
  if (visibility === 'public' && tuple[4] !== null) {
    privatePayloadError('WAL_PRIVATE_DOWNGRADE', 'public view cannot consume a private payload envelope');
  }
  return tuple;
}
