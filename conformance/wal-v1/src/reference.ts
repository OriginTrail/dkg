import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import { computeAddress, getBytes, hashMessage, recoverAddress, Signature, SigningKey } from 'ethers';
import { assertBytes, compareBytes, concat, equalBytes, fromHex, hash, hex, sortedUniqueBytes, u64be, utf8 } from './bytes.js';
import { assertTuple, decodeCanonical, encodeCanonical, type CborValue } from './cbor.js';
import { DOMAINS, ENUMS, LIMITS } from './schema.js';

export const FIXTURE_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

export interface WalObjectFields {
  version: 1;
  namespaceId: Uint8Array;
  writerId: Uint8Array;
  writerEpoch: bigint;
  sequence: bigint;
  previousObjectId: Uint8Array | null;
  payloadBytes: Uint8Array;
}

export interface SignedWalObject extends WalObjectFields {
  signature: Uint8Array;
  canonicalBytes: Uint8Array;
  id: Uint8Array;
}

export interface RangeFrame {
  walObjectId: Uint8Array;
  totalObjectLength: bigint;
  offset: bigint;
  bytes: Uint8Array;
}

export interface ReducerCase {
  name: string;
  operation: 'PUT' | 'PATCH' | 'DELETE' | 'RESOLVE' | 'MOVE_TIER_TARGET';
  currentHeads: Uint8Array[];
  baseHeads: Uint8Array[];
  touchedKeys: Uint8Array[];
  concurrentTouchedKeys: Uint8Array[];
  mode: 'REPLACE' | 'PATCH';
  resolutionHeads?: Uint8Array[];
  hasTierReceipt?: boolean;
}

export interface ReducerDecision {
  status: 'apply' | 'merge' | 'conflict' | 'pending';
  activeHeads: Uint8Array[];
  conflictHeads: Uint8Array[];
  headDigest: Uint8Array;
  conflictDigest: Uint8Array;
}

function addressBytes(privateKey: string): Uint8Array {
  return getBytes(computeAddress(privateKey));
}

export function signatureMessage(domain: string, unsignedTuple: readonly CborValue[]): Uint8Array {
  return hash(domain, encodeCanonical(unsignedTuple));
}

export function signTuple(domain: string, unsignedTuple: readonly CborValue[], privateKey = FIXTURE_PRIVATE_KEY): Uint8Array {
  const message = signatureMessage(domain, unsignedTuple);
  const signingKey = new SigningKey(privateKey);
  return getBytes(Signature.from(signingKey.sign(hashMessage(message))).serialized);
}

export function verifyTupleSignature(
  domain: string,
  unsignedTuple: readonly CborValue[],
  signature: Uint8Array,
  expectedAddress: Uint8Array
): boolean {
  if (signature.length !== 65 || expectedAddress.length !== 20) return false;
  try {
    const recovered = getBytes(recoverAddress(
      hashMessage(signatureMessage(domain, unsignedTuple)),
      `0x${hex(signature)}`
    ));
    return equalBytes(recovered, expectedAddress);
  } catch {
    return false;
  }
}

export function walUnsignedTuple(fields: WalObjectFields): CborValue[] {
  return [
    1n,
    fields.namespaceId,
    fields.writerId,
    fields.writerEpoch,
    fields.sequence,
    fields.previousObjectId,
    fields.payloadBytes
  ];
}

export function createWalObject(
  input: Omit<WalObjectFields, 'version' | 'writerId'> & { writerId?: Uint8Array },
  privateKey = FIXTURE_PRIVATE_KEY
): SignedWalObject {
  const fields: WalObjectFields = {
    version: 1,
    namespaceId: new Uint8Array(input.namespaceId),
    writerId: input.writerId === undefined ? addressBytes(privateKey) : new Uint8Array(input.writerId),
    writerEpoch: input.writerEpoch,
    sequence: input.sequence,
    previousObjectId: input.previousObjectId === null ? null : new Uint8Array(input.previousObjectId),
    payloadBytes: new Uint8Array(input.payloadBytes)
  };
  validateWalFields(fields);
  const unsigned = walUnsignedTuple(fields);
  const signature = signTuple(DOMAINS.walObjectSignature, unsigned, privateKey);
  const canonicalBytes = encodeCanonical([...unsigned, signature]);
  const id = hash(DOMAINS.walObjectId, canonicalBytes);
  return { ...fields, signature, canonicalBytes, id };
}

function asU64(value: CborValue, name: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new Error(`${name} must be u64`);
  return value;
}

function validateWalFields(fields: WalObjectFields): void {
  if (fields.version !== 1) throw new Error('unsupported WalObject version');
  assertBytes(fields.namespaceId, 32);
  assertBytes(fields.writerId, 20);
  asU64(fields.writerEpoch, 'writerEpoch');
  asU64(fields.sequence, 'sequence');
  if (fields.previousObjectId !== null) assertBytes(fields.previousObjectId, 32);
  if (fields.sequence === 0n && fields.previousObjectId !== null) throw new Error('sequence zero requires null previousObjectId');
  if (fields.sequence > 0n && fields.previousObjectId === null) throw new Error('nonzero sequence requires previousObjectId');
  assertBytes(fields.payloadBytes);
  if (fields.payloadBytes.length > LIMITS.walObjectHardBytes) throw new Error('payload exceeds hard object bound');
}

export function parseWalObject(canonicalBytes: Uint8Array): SignedWalObject {
  const value = decodeCanonical(canonicalBytes);
  assertTuple(value, 8, 'WalObjectV1');
  if (value[0] !== 1n) throw new Error('unsupported WalObject version');
  assertBytes(value[1], 32);
  assertBytes(value[2], 20);
  const writerEpoch = asU64(value[3], 'writerEpoch');
  const sequence = asU64(value[4], 'sequence');
  if (value[5] !== null) assertBytes(value[5], 32);
  assertBytes(value[6]);
  assertBytes(value[7], 65);
  const fields: WalObjectFields = {
    version: 1,
    namespaceId: value[1],
    writerId: value[2],
    writerEpoch,
    sequence,
    previousObjectId: value[5],
    payloadBytes: value[6]
  };
  validateWalFields(fields);
  if (!verifyTupleSignature(DOMAINS.walObjectSignature, value.slice(0, 7), value[7], value[2])) {
    throw new Error('invalid WalObject signature');
  }
  return {
    ...fields,
    signature: value[7],
    canonicalBytes: new Uint8Array(canonicalBytes),
    id: hash(DOMAINS.walObjectId, canonicalBytes)
  };
}

export function namespaceId(viewKey: readonly CborValue[]): Uint8Array {
  return hash(DOMAINS.namespaceId, encodeCanonical(viewKey));
}

export function collectionId(collectionKey: readonly CborValue[]): Uint8Array {
  return hash(DOMAINS.collectionId, encodeCanonical(collectionKey));
}

export function payloadAssociatedDataDigest(fields: {
  namespaceId: Uint8Array;
  writerId: Uint8Array;
  writerEpoch: bigint;
  sequence: bigint;
  envelopeVersion: 1;
  payloadKind: number;
  codec: number;
  mediaType: string;
  keyEpoch: bigint;
  nonce: Uint8Array;
}): Uint8Array {
  return hash(DOMAINS.payloadAssociatedData, encodeCanonical([
    fields.namespaceId,
    fields.writerId,
    fields.writerEpoch,
    fields.sequence,
    1n,
    BigInt(fields.payloadKind),
    BigInt(fields.codec),
    fields.mediaType,
    fields.keyEpoch,
    fields.nonce
  ]));
}

export function derivePrivateObjectKey(
  epochKey: Uint8Array,
  fields: Pick<WalObjectFields, 'namespaceId' | 'writerId' | 'writerEpoch' | 'sequence'>
): Uint8Array {
  assertBytes(epochKey, 32);
  assertBytes(fields.namespaceId, 32);
  assertBytes(fields.writerId, 20);
  const salt = concat(fields.writerId, u64be(fields.writerEpoch));
  const info = concat(utf8('dkg-wal-private-object-v1\0'), fields.namespaceId, u64be(fields.sequence));
  return new Uint8Array(hkdfSync('sha256', epochKey, salt, info, 32));
}

export function encryptAes256Gcm(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  associatedData: Uint8Array
): Uint8Array {
  if (key.length !== 32 || nonce.length !== 12) throw new Error('AES-256-GCM key/nonce length mismatch');
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(associatedData);
  return concat(cipher.update(plaintext), cipher.final(), cipher.getAuthTag());
}

export function decryptAes256Gcm(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertextAndTag: Uint8Array,
  associatedData: Uint8Array
): Uint8Array {
  if (ciphertextAndTag.length < 16) throw new Error('missing GCM authentication tag');
  const ciphertext = ciphertextAndTag.subarray(0, -16);
  const tag = ciphertextAndTag.subarray(-16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(associatedData);
  decipher.setAuthTag(tag);
  return concat(decipher.update(ciphertext), decipher.final());
}

export function encodeRangeFrame(frame: RangeFrame): Uint8Array {
  validateRangeFrame(frame);
  return encodeCanonical([frame.walObjectId, frame.totalObjectLength, frame.offset, frame.bytes]);
}

export function validateRangeFrame(frame: RangeFrame): void {
  assertBytes(frame.walObjectId, 32);
  asU64(frame.totalObjectLength, 'totalObjectLength');
  asU64(frame.offset, 'offset');
  assertBytes(frame.bytes);
  if (frame.totalObjectLength > BigInt(LIMITS.walObjectHardBytes)) throw new Error('dishonest or unsupported total object length');
  if (frame.bytes.length > LIMITS.walObjectRangeBytes) throw new Error('range exceeds protocol maximum');
  if (frame.offset > frame.totalObjectLength) throw new Error('range offset beyond object');
  const end = frame.offset + BigInt(frame.bytes.length);
  if (end > frame.totalObjectLength || end > 0xffff_ffff_ffff_ffffn) throw new Error('range arithmetic overflow or out of bounds');
  if (frame.bytes.length === 0 && frame.offset !== frame.totalObjectLength) throw new Error('zero-length range is only the EOF sentinel');
}

export function assembleRanges(frames: readonly RangeFrame[]): Uint8Array {
  if (frames.length === 0) throw new Error('no ranges');
  const first = frames[0];
  validateRangeFrame(first);
  if (first.totalObjectLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('fixture assembler length is not safely allocatable');
  const length = Number(first.totalObjectLength);
  const output = new Uint8Array(length);
  const present = new Uint8Array(length);
  for (const frame of frames) {
    validateRangeFrame(frame);
    if (!equalBytes(frame.walObjectId, first.walObjectId) || frame.totalObjectLength !== first.totalObjectLength) {
      throw new Error('cross-object or dishonest total length');
    }
    const offset = Number(frame.offset);
    for (let index = 0; index < frame.bytes.length; index += 1) {
      const position = offset + index;
      if (present[position] !== 0 && output[position] !== frame.bytes[index]) throw new Error('overlapping ranges disagree');
      output[position] = frame.bytes[index];
      present[position] = 1;
    }
  }
  if (present.some((value) => value === 0)) throw new Error('range set is incomplete');
  if (!equalBytes(hash(DOMAINS.walObjectId, output), first.walObjectId)) throw new Error('complete object ID mismatch');
  parseWalObject(output);
  return output;
}

function intersects(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  const rightSet = new Set(right.map(hex));
  return left.some((value) => rightSet.has(hex(value)));
}

function digestIds(domain: string, ids: readonly Uint8Array[]): Uint8Array {
  return hash(domain, encodeCanonical(sortedUniqueBytes(ids)));
}

export function reduceCase(input: ReducerCase): ReducerDecision {
  const current = sortedUniqueBytes(input.currentHeads);
  const base = sortedUniqueBytes(input.baseHeads);
  let status: ReducerDecision['status'];
  let activeHeads: Uint8Array[];
  let conflictHeads: Uint8Array[] = [];

  if (input.operation === 'MOVE_TIER_TARGET' && input.hasTierReceipt !== true) {
    status = 'pending';
    activeHeads = current;
  } else if (input.operation === 'RESOLVE') {
    const resolution = sortedUniqueBytes(input.resolutionHeads ?? []);
    const coversAll = resolution.length === current.length && resolution.every((id, index) => equalBytes(id, current[index]));
    if (!coversAll) {
      status = 'conflict';
      activeHeads = base;
      conflictHeads = current;
    } else {
      status = 'apply';
      activeHeads = base;
    }
  } else if (current.length === base.length && current.every((id, index) => equalBytes(id, base[index]))) {
    status = 'apply';
    activeHeads = current;
  } else if (
    input.operation === 'PATCH' &&
    input.mode === 'PATCH' &&
    !intersects(input.touchedKeys, input.concurrentTouchedKeys)
  ) {
    status = 'merge';
    activeHeads = current;
  } else {
    status = 'conflict';
    activeHeads = base;
    conflictHeads = current;
  }

  return {
    status,
    activeHeads,
    conflictHeads,
    headDigest: digestIds(DOMAINS.reducerHeads, activeHeads),
    conflictDigest: digestIds(DOMAINS.reducerConflict, conflictHeads)
  };
}

export function moveTierCommitment(input: {
  nonce: Uint8Array;
  sourceNamespaceId: Uint8Array;
  targetNamespaceId: Uint8Array;
  targetMutationDigest: Uint8Array;
  sourceStateDigest: Uint8Array;
  sourceResultDigest: Uint8Array;
}): Uint8Array {
  for (const value of Object.values(input)) assertBytes(value, 32);
  return hash(
    DOMAINS.moveTierCommitment,
    input.nonce,
    input.sourceNamespaceId,
    input.targetNamespaceId,
    input.targetMutationDigest,
    input.sourceStateDigest,
    input.sourceResultDigest
  );
}

export function assertPublicMoveTierSafe(publicPayloadBytes: Uint8Array, privateValues: readonly Uint8Array[]): void {
  for (const privateValue of privateValues) {
    if (privateValue.length === 0) continue;
    if (Buffer.from(publicPayloadBytes).includes(Buffer.from(privateValue))) throw new Error('public MOVE_TIER leaks private bytes');
  }
}

export function authorFinalityRequirement(recordValue: number, currentNetworkMinimum: number): number {
  if (!Number.isInteger(recordValue) || recordValue < 0 || recordValue > 0xffff_ffff) throw new Error('invalid record finality');
  if (!Number.isInteger(currentNetworkMinimum) || currentNetworkMinimum < 0 || currentNetworkMinimum > 0xffff_ffff) {
    throw new Error('invalid network finality');
  }
  return Math.max(recordValue, currentNetworkMinimum);
}

export function sampleEnvelope(content: Uint8Array): Uint8Array {
  return encodeCanonical([
    1n,
    BigInt(ENUMS.payloadKind.DKG_MUTATION),
    BigInt(ENUMS.codec.DETERMINISTIC_CBOR),
    'application/vnd.origintrail.dkg-mutation+cbor',
    null,
    content
  ]);
}

export function decodeHexWalObject(value: string): SignedWalObject {
  return parseWalObject(fromHex(value));
}
