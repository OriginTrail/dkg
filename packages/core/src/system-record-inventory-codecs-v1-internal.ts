import { sha256 } from '@noble/hashes/sha2.js';

import {
  canonicalizeJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from './canonical-json.js';
import { assertNetworkIdV1, type NetworkIdV1 } from './sync-wire-identifiers.js';
import {
  hasOwnDataProperty,
  snapshotDataArray,
  snapshotDataRecord,
  snapshotExactDataRecord,
} from './sync-wire-objects.js';
import {
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  parseCanonicalDecimalU64,
  type DecimalU64V1,
  type Digest32V1,
} from './sync-wire-scalars.js';
import {
  assertCanonicalSystemRecordPeerIdV1,
  copyBoundedSystemRecordBytesV1,
  decodeUnpaddedBase64UrlV1,
  digestSystemRecordBytesV1,
} from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX,
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_ED25519_SIGNATURE_BYTES,
  SYSTEM_RECORD_INTERNAL_MAX_ENTRIES,
  SYSTEM_RECORD_INTERNAL_MIN_ENTRIES,
  SYSTEM_RECORD_INVENTORY_ROW_VERSION,
  SYSTEM_RECORD_KIND_V1,
  SYSTEM_RECORD_LEAF_MAX_ROWS,
  SYSTEM_RECORD_LEAF_MIN_ROWS,
  SYSTEM_RECORD_MAX_EVIDENCE_ROW_BYTES,
  SYSTEM_RECORD_MAX_FLAT_JSON_DEPTH,
  SYSTEM_RECORD_MAX_INTERNAL_ENTRY_BYTES,
  SYSTEM_RECORD_MAX_INVENTORY_INTERNAL_JSON_DEPTH,
  SYSTEM_RECORD_MAX_INVENTORY_RECORDS,
  SYSTEM_RECORD_MAX_ORDINARY_ROW_BYTES,
  SYSTEM_RECORD_MAX_PEER_ID_BYTES,
  SYSTEM_RECORD_MAX_ROW_BYTES,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  SYSTEM_RECORD_ROOT_MAX_ENTRIES,
  SYSTEM_RECORD_ROOT_MIN_ENTRIES,
} from './system-record-limits-v1.js';

const UTF8 = new TextEncoder();
const MAP_GET = Map.prototype.get;
const MAP_HAS = Map.prototype.has;
const ROW_FLAG_TOMBSTONE = 1;
const ROW_FLAG_QUARANTINED = 2;
const ROW_FLAG_CONFLICT_EVIDENCE = 4;
const ROW_ALLOWED_FLAGS = ROW_FLAG_TOMBSTONE | ROW_FLAG_QUARANTINED | ROW_FLAG_CONFLICT_EVIDENCE;

export interface SystemRecordInventoryRowV1 {
  readonly stableKeyHash: Digest32V1;
  readonly peerId: string;
  readonly authoritySequence: DecimalU64V1;
  readonly version: DecimalU64V1;
  readonly headDigest: Digest32V1;
  readonly conflictEvidenceDigest?: Digest32V1;
  readonly tombstone: boolean;
  readonly quarantined: boolean;
}

export interface SystemRecordInventoryLeafObjectV1 {
  readonly objectType: 'inventory-leaf';
  readonly firstKeyHash?: Digest32V1;
  readonly lastKeyHash?: Digest32V1;
  readonly rows: readonly string[];
}

export interface SystemRecordInventoryInternalEntryV1 {
  readonly separatorKeyHash: Digest32V1;
  readonly childDigest: Digest32V1;
  readonly childKind: 'inventory-internal' | 'inventory-leaf';
}

export interface SystemRecordInventoryInternalObjectV1 {
  readonly objectType: 'inventory-internal';
  readonly firstKeyHash: Digest32V1;
  readonly lastKeyHash: Digest32V1;
  readonly entries: readonly SystemRecordInventoryInternalEntryV1[];
}

export type SystemRecordInventoryObjectV1 =
  | SystemRecordInventoryLeafObjectV1
  | SystemRecordInventoryInternalObjectV1;

export interface SystemRecordRootDescriptorObjectV1 {
  readonly objectType: 'root-descriptor';
  readonly kind: typeof SYSTEM_RECORD_KIND_V1;
  readonly networkId: NetworkIdV1;
  readonly epoch: DecimalU64V1;
  readonly version: DecimalU64V1;
  readonly priorRootDigest?: Digest32V1;
  readonly treeRootDigest: Digest32V1;
  readonly totalRows: DecimalU64V1;
}

export interface SignedSystemRecordRootDescriptorEnvelopeV1 {
  readonly object: SystemRecordRootDescriptorObjectV1;
  readonly objectDigest: Digest32V1;
  readonly providerPeerId: string;
  readonly signatureSuite: 'ed25519-v1';
  readonly signature: string;
}

export function computeSystemRecordStableKeyHashV1(
  networkId: NetworkIdV1,
  peerId: string,
): Digest32V1 {
  assertNetworkIdV1(networkId);
  assertCanonicalSystemRecordPeerIdV1(peerId);
  const network = UTF8.encode(networkId);
  const peer = UTF8.encode(peerId);
  if (peer.byteLength < 1 || peer.byteLength > SYSTEM_RECORD_MAX_PEER_ID_BYTES) {
    throw new Error(`peerId exceeds ${SYSTEM_RECORD_MAX_PEER_ID_BYTES} bytes`);
  }
  const input = new Uint8Array(network.byteLength + 1 + peer.byteLength);
  input.set(network);
  input[network.byteLength] = 0;
  input.set(peer, network.byteLength + 1);
  return `0x${Buffer.from(sha256(input)).toString('hex')}` as Digest32V1;
}

export function encodeSystemRecordInventoryRowV1(
  networkId: NetworkIdV1,
  row: SystemRecordInventoryRowV1,
): Uint8Array {
  const validated = validateInventoryRow(row, networkId);
  const peer = UTF8.encode(validated.peerId);
  const hasEvidence = validated.conflictEvidenceDigest !== undefined;
  const bytes = new Uint8Array(
    1 + 32 + 2 + peer.byteLength + 8 + 8 + 32 + (hasEvidence ? 32 : 0) + 1,
  );
  let offset = 0;
  bytes[offset++] = SYSTEM_RECORD_INVENTORY_ROW_VERSION;
  bytes.set(hexDigestBytes(validated.stableKeyHash), offset);
  offset += 32;
  bytes[offset++] = peer.byteLength >>> 8;
  bytes[offset++] = peer.byteLength & 0xff;
  bytes.set(peer, offset);
  offset += peer.byteLength;
  writeU64(bytes, offset, parseCanonicalDecimalU64(validated.authoritySequence));
  offset += 8;
  writeU64(bytes, offset, parseCanonicalDecimalU64(validated.version));
  offset += 8;
  bytes.set(hexDigestBytes(validated.headDigest), offset);
  offset += 32;
  if (hasEvidence) {
    bytes.set(hexDigestBytes(validated.conflictEvidenceDigest!), offset);
    offset += 32;
  }
  bytes[offset] =
    (validated.tombstone ? ROW_FLAG_TOMBSTONE : 0) |
    (validated.quarantined ? ROW_FLAG_QUARANTINED : 0) |
    (hasEvidence ? ROW_FLAG_CONFLICT_EVIDENCE : 0);
  const cap = hasEvidence
    ? SYSTEM_RECORD_MAX_EVIDENCE_ROW_BYTES
    : SYSTEM_RECORD_MAX_ORDINARY_ROW_BYTES;
  if (bytes.byteLength > cap || bytes.byteLength > SYSTEM_RECORD_MAX_ROW_BYTES) {
    throw new Error('encoded inventory row exceeds its V1 cap');
  }
  return bytes;
}

export function systemRecordInventoryRowMaxEncodedBytesV1(
  peerIdBytes = SYSTEM_RECORD_MAX_PEER_ID_BYTES,
  withConflictEvidence = false,
): number {
  if (
    !Number.isInteger(peerIdBytes) ||
    peerIdBytes < 1 ||
    peerIdBytes > SYSTEM_RECORD_MAX_PEER_ID_BYTES
  ) {
    throw new Error(`peerIdBytes must be in 1..${SYSTEM_RECORD_MAX_PEER_ID_BYTES}`);
  }
  return 1 + 32 + 2 + peerIdBytes + 8 + 8 + 32 + (withConflictEvidence ? 32 : 0) + 1;
}

export function decodeSystemRecordInventoryRowV1(
  networkId: NetworkIdV1,
  bytes: Uint8Array,
): SystemRecordInventoryRowV1 {
  assertNetworkIdV1(networkId);
  const encoded = copyBoundedSystemRecordBytesV1(
    bytes,
    SYSTEM_RECORD_MAX_ROW_BYTES,
    'inventory row bytes',
  );
  if (encoded.byteLength < 84) {
    throw new Error('inventory row has an invalid encoded length');
  }
  let offset = 0;
  if (encoded[offset++] !== SYSTEM_RECORD_INVENTORY_ROW_VERSION)
    throw new Error('inventory row version is invalid');
  const stableKeyHash = bytesDigest(encoded.subarray(offset, offset + 32));
  offset += 32;
  const peerLength = (encoded[offset++] << 8) | encoded[offset++];
  const hasEvidence = encoded.byteLength === 1 + 32 + 2 + peerLength + 8 + 8 + 32 + 32 + 1;
  const ordinary = encoded.byteLength === 1 + 32 + 2 + peerLength + 8 + 8 + 32 + 1;
  if (
    peerLength < 1 ||
    peerLength > SYSTEM_RECORD_MAX_PEER_ID_BYTES ||
    (!ordinary && !hasEvidence)
  ) {
    throw new Error('inventory row peer/evidence length is invalid');
  }
  const peerId = new TextDecoder('utf-8', { fatal: true }).decode(
    encoded.subarray(offset, offset + peerLength),
  );
  offset += peerLength;
  const authoritySequence = readU64(encoded, offset).toString() as DecimalU64V1;
  offset += 8;
  const version = readU64(encoded, offset).toString() as DecimalU64V1;
  offset += 8;
  const headDigest = bytesDigest(encoded.subarray(offset, offset + 32));
  offset += 32;
  const conflictEvidenceDigest = hasEvidence
    ? bytesDigest(encoded.subarray(offset, offset + 32))
    : undefined;
  if (hasEvidence) offset += 32;
  const flags = encoded[offset];
  if (
    (flags & ~ROW_ALLOWED_FLAGS) !== 0 ||
    Boolean(flags & ROW_FLAG_CONFLICT_EVIDENCE) !== hasEvidence
  ) {
    throw new Error('inventory row flags are invalid');
  }
  const row: SystemRecordInventoryRowV1 = {
    stableKeyHash,
    peerId,
    authoritySequence,
    version,
    headDigest,
    ...(conflictEvidenceDigest === undefined ? {} : { conflictEvidenceDigest }),
    tombstone: Boolean(flags & ROW_FLAG_TOMBSTONE),
    quarantined: Boolean(flags & ROW_FLAG_QUARANTINED),
  };
  return validateInventoryRow(row, networkId);
}

export function encodeInventoryRowBase64UrlV1(
  networkId: NetworkIdV1,
  row: SystemRecordInventoryRowV1,
): string {
  return Buffer.from(encodeSystemRecordInventoryRowV1(networkId, row)).toString('base64url');
}

export function decodeInventoryRowBase64UrlV1(
  networkId: NetworkIdV1,
  value: string,
): SystemRecordInventoryRowV1 {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil((SYSTEM_RECORD_MAX_ROW_BYTES * 4) / 3) ||
    value.includes('=') ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error('inventory row must be unpadded base64url');
  }
  const bytes = Uint8Array.from(Buffer.from(value, 'base64url'));
  if (Buffer.from(bytes).toString('base64url') !== value)
    throw new Error('inventory row base64url is noncanonical');
  return decodeSystemRecordInventoryRowV1(networkId, bytes);
}

export function assertSystemRecordInventoryLeafObjectV1(
  value: unknown,
  networkId: NetworkIdV1,
  root = false,
): asserts value is SystemRecordInventoryLeafObjectV1 {
  validateLeaf(value, networkId, root);
}

export function canonicalizeSystemRecordInventoryLeafObjectV1(
  value: SystemRecordInventoryLeafObjectV1,
  networkId: NetworkIdV1,
  root = false,
): Uint8Array {
  const validated = validateLeaf(value, networkId, root);
  return canonicalizeJsonBytes(validated as unknown as CanonicalJsonValue, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['inventory-leaf'],
  });
}

export function parseCanonicalSystemRecordInventoryLeafObjectV1(
  input: string | Uint8Array,
  networkId: NetworkIdV1,
  root = false,
): SystemRecordInventoryLeafObjectV1 {
  return validateLeaf(
    parseCanonicalJson(input, {
      maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['inventory-leaf'],
      maxDepth: SYSTEM_RECORD_MAX_FLAT_JSON_DEPTH,
    }),
    networkId,
    root,
  );
}

export function computeSystemRecordInventoryLeafDigestV1(
  value: SystemRecordInventoryLeafObjectV1,
  networkId: NetworkIdV1,
  root = false,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.inventoryLeaf,
    canonicalizeSystemRecordInventoryLeafObjectV1(value, networkId, root),
  );
}

export function validateLeaf(
  value: unknown,
  networkId: NetworkIdV1,
  root: boolean,
): SystemRecordInventoryLeafObjectV1 {
  assertNetworkIdV1(networkId);
  const probe = snapshotDataRecord(value, 'inventory leaf', {
    rejectNullValues: true,
  });
  const encodedRows = snapshotDataArray(probe.rows, 'inventory leaf rows', {
    maxLength: SYSTEM_RECORD_LEAF_MAX_ROWS,
  });
  const empty = encodedRows.length === 0;
  const expected = empty
    ? (['objectType', 'rows'] as const)
    : (['objectType', 'firstKeyHash', 'lastKeyHash', 'rows'] as const);
  const leaf = snapshotExactDataRecord(probe, expected, 'inventory leaf');
  if (leaf.objectType !== 'inventory-leaf') throw new Error('inventory leaf tag is invalid');
  const minimum = root ? 0 : SYSTEM_RECORD_LEAF_MIN_ROWS;
  if (encodedRows.length < minimum || encodedRows.length > SYSTEM_RECORD_LEAF_MAX_ROWS) {
    throw new Error('inventory leaf occupancy is outside its V1 bound');
  }
  const rows = encodedRows.map((encoded) =>
    decodeInventoryRowBase64UrlV1(networkId, encoded as string),
  );
  for (let index = 1; index < rows.length; index += 1) {
    if (compareRows(rows[index - 1], rows[index]) >= 0) {
      throw new Error('inventory leaf rows must be sorted and stable-key unique');
    }
  }
  if (!empty) {
    assertCanonicalDigest(leaf.firstKeyHash);
    assertCanonicalDigest(leaf.lastKeyHash);
    if (
      leaf.firstKeyHash !== rows[0].stableKeyHash ||
      leaf.lastKeyHash !== rows[rows.length - 1].stableKeyHash
    ) {
      throw new Error('inventory leaf key range is not derived from its rows');
    }
  }
  const validated = empty
    ? {
        objectType: 'inventory-leaf' as const,
        rows: encodedRows as readonly string[],
      }
    : {
        objectType: 'inventory-leaf' as const,
        firstKeyHash: leaf.firstKeyHash as Digest32V1,
        lastKeyHash: leaf.lastKeyHash as Digest32V1,
        rows: encodedRows as readonly string[],
      };
  const bytes = canonicalizeJsonBytes(validated as unknown as CanonicalJsonValue, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['inventory-leaf'],
  });
  if (bytes.byteLength > SYSTEM_RECORD_OBJECT_CAPS_V1['inventory-leaf']) {
    throw new Error('inventory leaf exceeds its V1 byte cap');
  }
  return Object.freeze(validated);
}

export function assertSystemRecordInventoryInternalObjectV1(
  value: unknown,
  root = false,
): asserts value is SystemRecordInventoryInternalObjectV1 {
  validateInternal(value, root);
}

export function canonicalizeSystemRecordInventoryInternalObjectV1(
  value: SystemRecordInventoryInternalObjectV1,
  root = false,
): Uint8Array {
  const validated = validateInternal(value, root);
  return canonicalizeJsonBytes(validated as unknown as CanonicalJsonValue, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['inventory-internal'],
  });
}

export function parseCanonicalSystemRecordInventoryInternalObjectV1(
  input: string | Uint8Array,
  root = false,
): SystemRecordInventoryInternalObjectV1 {
  return validateInternal(
    parseCanonicalJson(input, {
      maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['inventory-internal'],
      maxDepth: SYSTEM_RECORD_MAX_INVENTORY_INTERNAL_JSON_DEPTH,
    }),
    root,
  );
}

export function computeSystemRecordInventoryInternalDigestV1(
  value: SystemRecordInventoryInternalObjectV1,
  root = false,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.inventoryInternal,
    canonicalizeSystemRecordInventoryInternalObjectV1(value, root),
  );
}

export function validateInternal(
  value: unknown,
  root: boolean,
): SystemRecordInventoryInternalObjectV1 {
  const internal = snapshotExactDataRecord(
    value,
    ['objectType', 'firstKeyHash', 'lastKeyHash', 'entries'],
    'inventory internal node',
  );
  if (internal.objectType !== 'inventory-internal')
    throw new Error('inventory internal node tag is invalid');
  assertCanonicalDigest(internal.firstKeyHash);
  assertCanonicalDigest(internal.lastKeyHash);
  const min = root ? SYSTEM_RECORD_ROOT_MIN_ENTRIES : SYSTEM_RECORD_INTERNAL_MIN_ENTRIES;
  const max = root ? SYSTEM_RECORD_ROOT_MAX_ENTRIES : SYSTEM_RECORD_INTERNAL_MAX_ENTRIES;
  const internalEntries = snapshotDataArray(internal.entries, 'inventory internal entries', {
    minLength: min,
    maxLength: max,
  });
  let previousSeparator: string | undefined;
  let childKind: SystemRecordInventoryInternalEntryV1['childKind'] | undefined;
  const entries = internalEntries.map((candidate, index) => {
    const entry = snapshotExactDataRecord(
      candidate,
      ['separatorKeyHash', 'childDigest', 'childKind'],
      `inventory internal entry ${index}`,
    );
    assertCanonicalDigest(entry.separatorKeyHash);
    assertCanonicalDigest(entry.childDigest);
    if (entry.childKind !== 'inventory-internal' && entry.childKind !== 'inventory-leaf') {
      throw new Error('inventory internal child kind is invalid');
    }
    if (childKind !== undefined && entry.childKind !== childKind) {
      throw new Error('inventory internal node must not mix leaf and internal children');
    }
    childKind = entry.childKind;
    const encoded = canonicalizeJsonBytes(entry as unknown as CanonicalJsonValue, {
      maxBytes: SYSTEM_RECORD_MAX_INTERNAL_ENTRY_BYTES,
    });
    if (encoded.byteLength > SYSTEM_RECORD_MAX_INTERNAL_ENTRY_BYTES) {
      throw new Error('inventory internal entry exceeds its V1 cap');
    }
    if (
      previousSeparator !== undefined &&
      previousSeparator >= (entry.separatorKeyHash as string)
    ) {
      throw new Error('inventory internal separators must be sorted and unique');
    }
    previousSeparator = entry.separatorKeyHash as string;
    return Object.freeze({
      ...entry,
    }) as unknown as SystemRecordInventoryInternalEntryV1;
  });
  if (
    internal.firstKeyHash !== entries[0].separatorKeyHash ||
    internal.lastKeyHash < entries[entries.length - 1].separatorKeyHash
  ) {
    throw new Error('inventory internal key range is not derived from its entries');
  }
  const validated = Object.freeze({
    objectType: 'inventory-internal' as const,
    firstKeyHash: internal.firstKeyHash as Digest32V1,
    lastKeyHash: internal.lastKeyHash as Digest32V1,
    entries: Object.freeze(entries),
  });
  canonicalizeJsonBytes(validated as unknown as CanonicalJsonValue, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['inventory-internal'],
  });
  return validated;
}

export function assertSystemRecordRootDescriptorObjectV1(
  value: unknown,
): asserts value is SystemRecordRootDescriptorObjectV1 {
  validateRootDescriptor(value);
}

export function canonicalizeSystemRecordRootDescriptorObjectV1(
  value: SystemRecordRootDescriptorObjectV1,
): Uint8Array {
  return canonicalizeJsonBytes(validateRootDescriptor(value) as unknown as CanonicalJsonValue, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['root-descriptor'],
  });
}

export function parseCanonicalSystemRecordRootDescriptorObjectV1(
  input: string | Uint8Array,
): SystemRecordRootDescriptorObjectV1 {
  return validateRootDescriptor(
    parseCanonicalJson(input, {
      maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['root-descriptor'],
      maxDepth: SYSTEM_RECORD_MAX_FLAT_JSON_DEPTH,
    }),
  );
}

export function computeSystemRecordRootDescriptorDigestV1(
  value: SystemRecordRootDescriptorObjectV1,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.rootDescriptor,
    canonicalizeSystemRecordRootDescriptorObjectV1(value),
  );
}

export function validateRootDescriptor(value: unknown): SystemRecordRootDescriptorObjectV1 {
  const probe = snapshotDataRecord(value, 'root descriptor', {
    rejectNullValues: true,
  });
  const hasPrior = hasOwnDataProperty(probe, 'priorRootDigest');
  const descriptor = snapshotExactDataRecord(
    probe,
    [
      'objectType',
      'kind',
      'networkId',
      'epoch',
      'version',
      ...(hasPrior ? ['priorRootDigest'] : []),
      'treeRootDigest',
      'totalRows',
    ],
    'root descriptor',
  );
  if (descriptor.objectType !== 'root-descriptor' || descriptor.kind !== SYSTEM_RECORD_KIND_V1) {
    throw new Error('root descriptor tag is invalid');
  }
  assertNetworkIdV1(descriptor.networkId);
  assertCanonicalDecimalU64(descriptor.epoch);
  const version = parseCanonicalDecimalU64(descriptor.version);
  if ((version === 0n) === hasPrior) {
    throw new Error('priorRootDigest is omitted only for root version zero');
  }
  if (hasPrior) assertCanonicalDigest(descriptor.priorRootDigest);
  assertCanonicalDigest(descriptor.treeRootDigest);
  const totalRows = parseCanonicalDecimalU64(descriptor.totalRows);
  if (totalRows > BigInt(SYSTEM_RECORD_MAX_INVENTORY_RECORDS)) {
    throw new Error('root descriptor exceeds the incoming inventory row cap');
  }
  return Object.freeze({
    ...descriptor,
  }) as unknown as SystemRecordRootDescriptorObjectV1;
}

export function assertSignedSystemRecordRootDescriptorEnvelopeV1(
  value: unknown,
): asserts value is SignedSystemRecordRootDescriptorEnvelopeV1 {
  validateSignedRootDescriptor(value);
}

export function canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1(
  value: SignedSystemRecordRootDescriptorEnvelopeV1,
): Uint8Array {
  return canonicalizeJsonBytes(
    validateSignedRootDescriptor(value) as unknown as CanonicalJsonValue,
    { maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['root-descriptor'] },
  );
}

export function parseCanonicalSignedSystemRecordRootDescriptorEnvelopeV1(
  input: string | Uint8Array,
): SignedSystemRecordRootDescriptorEnvelopeV1 {
  return validateSignedRootDescriptor(
    parseCanonicalJson(input, {
      maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['root-descriptor'],
      maxDepth: SYSTEM_RECORD_MAX_FLAT_JSON_DEPTH,
    }),
  );
}

export function validateSignedRootDescriptor(
  value: unknown,
): SignedSystemRecordRootDescriptorEnvelopeV1 {
  const envelope = snapshotExactDataRecord(
    value,
    ['object', 'objectDigest', 'providerPeerId', 'signatureSuite', 'signature'],
    'signed root descriptor envelope',
  );
  const object = validateRootDescriptor(envelope.object);
  assertCanonicalDigest(envelope.objectDigest);
  if (envelope.objectDigest !== computeSystemRecordRootDescriptorDigestV1(object)) {
    throw new Error('root descriptor objectDigest is invalid');
  }
  try {
    assertCanonicalSystemRecordPeerIdV1(envelope.providerPeerId);
  } catch {
    throw new Error('providerPeerId is not canonical');
  }
  if (envelope.signatureSuite !== 'ed25519-v1')
    throw new Error('provider signature suite is invalid');
  decodeUnpaddedBase64UrlV1(
    envelope.signature,
    SYSTEM_RECORD_ED25519_SIGNATURE_BYTES,
    'provider signature',
  );
  return Object.freeze({
    ...envelope,
    object,
  }) as unknown as SignedSystemRecordRootDescriptorEnvelopeV1;
}

export function validateInventoryRow(
  row: unknown,
  networkId?: NetworkIdV1,
): SystemRecordInventoryRowV1 {
  const probe = snapshotDataRecord(row, 'inventory row', {
    rejectNullValues: true,
  });
  const hasConflictEvidence = hasOwnDataProperty(probe, 'conflictEvidenceDigest');
  const expected = [
    'stableKeyHash',
    'peerId',
    'authoritySequence',
    'version',
    'headDigest',
    ...(hasConflictEvidence ? ['conflictEvidenceDigest'] : []),
    'tombstone',
    'quarantined',
  ];
  const validated = snapshotExactDataRecord(probe, expected, 'inventory row');
  assertCanonicalDigest(validated.stableKeyHash);
  try {
    assertCanonicalSystemRecordPeerIdV1(validated.peerId);
  } catch {
    throw new Error('inventory row peerId is not canonical');
  }
  if (
    parseCanonicalDecimalU64(validated.authoritySequence) > SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX
  ) {
    throw new Error('inventory row authoritySequence exceeds the V1 cap');
  }
  assertCanonicalDecimalU64(validated.version);
  assertCanonicalDigest(validated.headDigest);
  if (hasConflictEvidence) {
    assertCanonicalDigest(validated.conflictEvidenceDigest);
  }
  if (typeof validated.tombstone !== 'boolean' || typeof validated.quarantined !== 'boolean') {
    throw new Error('inventory row flags must be booleans');
  }
  if (validated.tombstone && (validated.quarantined || hasConflictEvidence)) {
    throw new Error('tombstone inventory rows cannot advertise quarantine or conflict evidence');
  }
  if (hasConflictEvidence && !validated.quarantined) {
    throw new Error('conflict evidence may appear only on quarantined rows');
  }
  if (validated.quarantined && !hasConflictEvidence) {
    throw new Error('quarantined inventory rows require conflict evidence');
  }
  if (
    networkId !== undefined &&
    validated.stableKeyHash !==
      computeSystemRecordStableKeyHashV1(networkId, validated.peerId as string)
  ) {
    throw new Error('inventory row stable key hash does not bind networkId/peerId');
  }
  return Object.freeze({
    ...validated,
  }) as unknown as SystemRecordInventoryRowV1;
}

export function compareRows(
  left: SystemRecordInventoryRowV1,
  right: SystemRecordInventoryRowV1,
): number {
  if (left.stableKeyHash !== right.stableKeyHash)
    return left.stableKeyHash < right.stableKeyHash ? -1 : 1;
  if (left.peerId === right.peerId) return 0;
  // Same hash with a different peer is a collision refusal, not a secondary bucket.
  throw new Error('stable-key hash collision between different canonical peers');
}

function writeU64(target: Uint8Array, offset: number, value: bigint): void {
  for (let index = 7; index >= 0; index -= 1) {
    target[offset + index] = Number(value & 0xffn);
    value >>= 8n;
  }
}

function readU64(source: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(source[offset + index]);
  return value;
}

function hexDigestBytes(value: Digest32V1): Uint8Array {
  assertCanonicalDigest(value);
  return Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
}

function bytesDigest(value: Uint8Array): Digest32V1 {
  if (value.byteLength !== 32) throw new Error('digest must be 32 bytes');
  return `0x${Buffer.from(value).toString('hex')}` as Digest32V1;
}
