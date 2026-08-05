import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { verifyAsync as verifyEd25519 } from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  canonicalizeJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from './canonical-json.js';
import {
  assertCanonicalSystemRecordPeerIdV1,
  decodeUnpaddedBase64UrlV1,
  digestSystemRecordBytesV1,
  type SystemRecordPeerPublicKeyV1,
} from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX,
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_ED25519_PUBLIC_KEY_BYTES,
  SYSTEM_RECORD_ED25519_SIGNATURE_BYTES,
  SYSTEM_RECORD_INTERNAL_MAX_ENTRIES,
  SYSTEM_RECORD_INTERNAL_MIN_ENTRIES,
  SYSTEM_RECORD_INTERNAL_TARGET_BYTES,
  SYSTEM_RECORD_INVENTORY_ROW_VERSION,
  SYSTEM_RECORD_KIND_V1,
  SYSTEM_RECORD_LEAF_MAX_ROWS,
  SYSTEM_RECORD_LEAF_MIN_ROWS,
  SYSTEM_RECORD_LEAF_TARGET_BYTES,
  SYSTEM_RECORD_MAX_EVIDENCE_ROW_BYTES,
  SYSTEM_RECORD_MAX_FLAT_JSON_DEPTH,
  SYSTEM_RECORD_MAX_HEADER_BYTES,
  SYSTEM_RECORD_MAX_INTERNAL_ENTRY_BYTES,
  SYSTEM_RECORD_MAX_INVENTORY_INTERNAL_JSON_DEPTH,
  SYSTEM_RECORD_MAX_INVENTORY_LEAVES,
  SYSTEM_RECORD_MAX_INVENTORY_OBJECTS,
  SYSTEM_RECORD_MAX_INVENTORY_RECORDS,
  SYSTEM_RECORD_MAX_ORDINARY_ROW_BYTES,
  SYSTEM_RECORD_MAX_PEER_ID_BYTES,
  SYSTEM_RECORD_MAX_ROW_BYTES,
  SYSTEM_RECORD_MAX_SLICE_REQUESTS,
  SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES,
  SYSTEM_RECORD_MAX_TREE_HEIGHT,
  SYSTEM_RECORD_MAX_TREE_UPDATE_BYTES,
  SYSTEM_RECORD_MAX_TREE_UPDATE_OBJECTS,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  SYSTEM_RECORD_ROOT_MAX_ENTRIES,
  SYSTEM_RECORD_ROOT_MIN_ENTRIES,
  SYSTEM_RECORD_SIGNATURE_DOMAINS_V1,
} from './system-record-limits-v1.js';
import { assertNetworkIdV1, type NetworkIdV1 } from './sync-wire-identifiers.js';
import {
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  parseCanonicalDecimalU64,
  type DecimalU64V1,
  type Digest32V1,
} from './sync-wire-scalars.js';
import { snapshotExactDataRecord } from './sync-wire-objects.js';

const UTF8 = new TextEncoder();
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
  return (`0x${Buffer.from(sha256(input)).toString('hex')}`) as Digest32V1;
}

export function encodeSystemRecordInventoryRowV1(
  networkId: NetworkIdV1,
  row: SystemRecordInventoryRowV1,
): Uint8Array {
  validateInventoryRow(row, networkId);
  const peer = UTF8.encode(row.peerId);
  const hasEvidence = row.conflictEvidenceDigest !== undefined;
  const bytes = new Uint8Array(1 + 32 + 2 + peer.byteLength + 8 + 8 + 32 + (hasEvidence ? 32 : 0) + 1);
  let offset = 0;
  bytes[offset++] = SYSTEM_RECORD_INVENTORY_ROW_VERSION;
  bytes.set(hexDigestBytes(row.stableKeyHash), offset); offset += 32;
  bytes[offset++] = peer.byteLength >>> 8;
  bytes[offset++] = peer.byteLength & 0xff;
  bytes.set(peer, offset); offset += peer.byteLength;
  writeU64(bytes, offset, parseCanonicalDecimalU64(row.authoritySequence)); offset += 8;
  writeU64(bytes, offset, parseCanonicalDecimalU64(row.version)); offset += 8;
  bytes.set(hexDigestBytes(row.headDigest), offset); offset += 32;
  if (hasEvidence) {
    bytes.set(hexDigestBytes(row.conflictEvidenceDigest!), offset); offset += 32;
  }
  bytes[offset] = (row.tombstone ? ROW_FLAG_TOMBSTONE : 0)
    | (row.quarantined ? ROW_FLAG_QUARANTINED : 0)
    | (hasEvidence ? ROW_FLAG_CONFLICT_EVIDENCE : 0);
  const cap = hasEvidence ? SYSTEM_RECORD_MAX_EVIDENCE_ROW_BYTES : SYSTEM_RECORD_MAX_ORDINARY_ROW_BYTES;
  if (bytes.byteLength > cap || bytes.byteLength > SYSTEM_RECORD_MAX_ROW_BYTES) {
    throw new Error('encoded inventory row exceeds its V1 cap');
  }
  return bytes;
}

export function systemRecordInventoryRowMaxEncodedBytesV1(
  peerIdBytes = SYSTEM_RECORD_MAX_PEER_ID_BYTES,
  withConflictEvidence = false,
): number {
  if (!Number.isInteger(peerIdBytes) || peerIdBytes < 1 || peerIdBytes > SYSTEM_RECORD_MAX_PEER_ID_BYTES) {
    throw new Error(`peerIdBytes must be in 1..${SYSTEM_RECORD_MAX_PEER_ID_BYTES}`);
  }
  return 1 + 32 + 2 + peerIdBytes + 8 + 8 + 32 + (withConflictEvidence ? 32 : 0) + 1;
}

export function decodeSystemRecordInventoryRowV1(
  networkId: NetworkIdV1,
  bytes: Uint8Array,
): SystemRecordInventoryRowV1 {
  assertNetworkIdV1(networkId);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 84 || bytes.byteLength > SYSTEM_RECORD_MAX_ROW_BYTES) {
    throw new Error('inventory row has an invalid encoded length');
  }
  let offset = 0;
  if (bytes[offset++] !== SYSTEM_RECORD_INVENTORY_ROW_VERSION) throw new Error('inventory row version is invalid');
  const stableKeyHash = bytesDigest(bytes.subarray(offset, offset + 32)); offset += 32;
  const peerLength = (bytes[offset++] << 8) | bytes[offset++];
  const hasEvidence = bytes.byteLength === 1 + 32 + 2 + peerLength + 8 + 8 + 32 + 32 + 1;
  const ordinary = bytes.byteLength === 1 + 32 + 2 + peerLength + 8 + 8 + 32 + 1;
  if (peerLength < 1 || peerLength > SYSTEM_RECORD_MAX_PEER_ID_BYTES || (!ordinary && !hasEvidence)) {
    throw new Error('inventory row peer/evidence length is invalid');
  }
  const peerId = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + peerLength));
  offset += peerLength;
  const authoritySequence = readU64(bytes, offset).toString() as DecimalU64V1; offset += 8;
  const version = readU64(bytes, offset).toString() as DecimalU64V1; offset += 8;
  const headDigest = bytesDigest(bytes.subarray(offset, offset + 32)); offset += 32;
  const conflictEvidenceDigest = hasEvidence
    ? bytesDigest(bytes.subarray(offset, offset + 32))
    : undefined;
  if (hasEvidence) offset += 32;
  const flags = bytes[offset];
  if ((flags & ~ROW_ALLOWED_FLAGS) !== 0
    || Boolean(flags & ROW_FLAG_CONFLICT_EVIDENCE) !== hasEvidence) {
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
  validateInventoryRow(row, networkId);
  return Object.freeze(row);
}

export function encodeInventoryRowBase64UrlV1(
  networkId: NetworkIdV1,
  row: SystemRecordInventoryRowV1,
): string {
  return Buffer.from(encodeSystemRecordInventoryRowV1(networkId, row)).toString('base64url');
}

export function decodeInventoryRowBase64UrlV1(networkId: NetworkIdV1, value: string): SystemRecordInventoryRowV1 {
  if (typeof value !== 'string' || value.includes('=') || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('inventory row must be unpadded base64url');
  }
  const bytes = Uint8Array.from(Buffer.from(value, 'base64url'));
  if (Buffer.from(bytes).toString('base64url') !== value) throw new Error('inventory row base64url is noncanonical');
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
  return validateLeaf(parseCanonicalJson(input, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['inventory-leaf'], maxDepth: SYSTEM_RECORD_MAX_FLAT_JSON_DEPTH,
  }), networkId, root);
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

function validateLeaf(
  value: unknown,
  networkId: NetworkIdV1,
  root: boolean,
): SystemRecordInventoryLeafObjectV1 {
  assertNetworkIdV1(networkId);
  const probe = plainRecord(value, 'inventory leaf');
  if (!Array.isArray(probe.rows)) throw new Error('inventory leaf rows must be an array');
  const empty = probe.rows.length === 0;
  const expected = empty
    ? ['objectType', 'rows'] as const
    : ['objectType', 'firstKeyHash', 'lastKeyHash', 'rows'] as const;
  const leaf = snapshotExactDataRecord(value, expected, 'inventory leaf');
  if (leaf.objectType !== 'inventory-leaf') throw new Error('inventory leaf tag is invalid');
  const encodedRows = leaf.rows as unknown as string[];
  const minimum = root ? 0 : SYSTEM_RECORD_LEAF_MIN_ROWS;
  if (encodedRows.length < minimum || encodedRows.length > SYSTEM_RECORD_LEAF_MAX_ROWS) {
    throw new Error('inventory leaf occupancy is outside its V1 bound');
  }
  const rows = encodedRows.map((encoded) => decodeInventoryRowBase64UrlV1(networkId, encoded));
  for (let index = 1; index < rows.length; index += 1) {
    if (compareRows(rows[index - 1], rows[index]) >= 0) {
      throw new Error('inventory leaf rows must be sorted and stable-key unique');
    }
  }
  if (!empty) {
    assertCanonicalDigest(leaf.firstKeyHash);
    assertCanonicalDigest(leaf.lastKeyHash);
    if (leaf.firstKeyHash !== rows[0].stableKeyHash
      || leaf.lastKeyHash !== rows[rows.length - 1].stableKeyHash) {
      throw new Error('inventory leaf key range is not derived from its rows');
    }
  }
  const validated = empty
    ? { objectType: 'inventory-leaf' as const, rows: Object.freeze([...encodedRows]) }
    : {
        objectType: 'inventory-leaf' as const,
        firstKeyHash: leaf.firstKeyHash as Digest32V1,
        lastKeyHash: leaf.lastKeyHash as Digest32V1,
        rows: Object.freeze([...encodedRows]),
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
  return validateInternal(parseCanonicalJson(input, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['inventory-internal'], maxDepth: SYSTEM_RECORD_MAX_INVENTORY_INTERNAL_JSON_DEPTH,
  }), root);
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

function validateInternal(value: unknown, root: boolean): SystemRecordInventoryInternalObjectV1 {
  const internal = snapshotExactDataRecord(
    value,
    ['objectType', 'firstKeyHash', 'lastKeyHash', 'entries'],
    'inventory internal node',
  );
  if (internal.objectType !== 'inventory-internal' || !Array.isArray(internal.entries)) {
    throw new Error('inventory internal node tag/entries are invalid');
  }
  assertCanonicalDigest(internal.firstKeyHash);
  assertCanonicalDigest(internal.lastKeyHash);
  const min = root ? SYSTEM_RECORD_ROOT_MIN_ENTRIES : SYSTEM_RECORD_INTERNAL_MIN_ENTRIES;
  const max = root ? SYSTEM_RECORD_ROOT_MAX_ENTRIES : SYSTEM_RECORD_INTERNAL_MAX_ENTRIES;
  if (internal.entries.length < min || internal.entries.length > max) {
    throw new Error('inventory internal occupancy is outside its V1 bound');
  }
  let previousSeparator: string | undefined;
  let childKind: SystemRecordInventoryInternalEntryV1['childKind'] | undefined;
  const entries = internal.entries.map((candidate, index) => {
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
    if (previousSeparator !== undefined && previousSeparator >= (entry.separatorKeyHash as string)) {
      throw new Error('inventory internal separators must be sorted and unique');
    }
    previousSeparator = entry.separatorKeyHash as string;
    return Object.freeze({ ...entry }) as unknown as SystemRecordInventoryInternalEntryV1;
  });
  if (internal.firstKeyHash !== entries[0].separatorKeyHash
    || internal.lastKeyHash < entries[entries.length - 1].separatorKeyHash) {
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
  return canonicalizeJsonBytes(
    validateRootDescriptor(value) as unknown as CanonicalJsonValue,
    { maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['root-descriptor'] },
  );
}

export function parseCanonicalSystemRecordRootDescriptorObjectV1(
  input: string | Uint8Array,
): SystemRecordRootDescriptorObjectV1 {
  return validateRootDescriptor(parseCanonicalJson(input, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['root-descriptor'], maxDepth: SYSTEM_RECORD_MAX_FLAT_JSON_DEPTH,
  }));
}

export function computeSystemRecordRootDescriptorDigestV1(
  value: SystemRecordRootDescriptorObjectV1,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.rootDescriptor,
    canonicalizeSystemRecordRootDescriptorObjectV1(value),
  );
}

function validateRootDescriptor(value: unknown): SystemRecordRootDescriptorObjectV1 {
  const probe = plainRecord(value, 'root descriptor');
  const hasPrior = Object.prototype.hasOwnProperty.call(probe, 'priorRootDigest');
  const descriptor = snapshotExactDataRecord(
    value,
    [
      'objectType', 'kind', 'networkId', 'epoch', 'version',
      ...(hasPrior ? ['priorRootDigest'] : []),
      'treeRootDigest', 'totalRows',
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
  return Object.freeze({ ...descriptor }) as unknown as SystemRecordRootDescriptorObjectV1;
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
  return validateSignedRootDescriptor(parseCanonicalJson(input, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['root-descriptor'],
    maxDepth: SYSTEM_RECORD_MAX_FLAT_JSON_DEPTH,
  }));
}

export function buildSystemRecordProviderSignatureMessageV1(
  descriptor: SystemRecordRootDescriptorObjectV1,
  descriptorObjectDigest: Digest32V1,
  providerPeerId: string,
): Uint8Array {
  validateRootDescriptor(descriptor);
  assertCanonicalDigest(descriptorObjectDigest);
  const tuple: CanonicalJsonValue = [
    descriptor.kind,
    descriptor.networkId,
    providerPeerId,
    descriptorObjectDigest,
  ];
  return concatBytes(
    UTF8.encode(SYSTEM_RECORD_SIGNATURE_DOMAINS_V1.provider),
    canonicalizeJsonBytes(tuple),
  );
}

export async function verifySignedSystemRecordRootDescriptorEnvelopeV1(
  envelope: SignedSystemRecordRootDescriptorEnvelopeV1,
  providerPeerPublicKey: SystemRecordPeerPublicKeyV1,
): Promise<boolean> {
  const validated = validateSignedRootDescriptor(envelope);
  const keyBytes = decodeUnpaddedBase64UrlV1(
    providerPeerPublicKey,
    SYSTEM_RECORD_ED25519_PUBLIC_KEY_BYTES,
    'providerPeerPublicKey',
  );
  if (peerIdFromPublicKey(publicKeyFromRaw(keyBytes)).toString() !== validated.providerPeerId) {
    return false;
  }
  const signature = decodeUnpaddedBase64UrlV1(
    validated.signature,
    SYSTEM_RECORD_ED25519_SIGNATURE_BYTES,
    'provider signature',
  );
  return verifyEd25519(
    signature,
    buildSystemRecordProviderSignatureMessageV1(
      validated.object,
      validated.objectDigest,
      validated.providerPeerId,
    ),
    keyBytes,
  );
}

function validateSignedRootDescriptor(value: unknown): SignedSystemRecordRootDescriptorEnvelopeV1 {
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
  if (envelope.signatureSuite !== 'ed25519-v1') throw new Error('provider signature suite is invalid');
  decodeUnpaddedBase64UrlV1(
    envelope.signature,
    SYSTEM_RECORD_ED25519_SIGNATURE_BYTES,
    'provider signature',
  );
  return Object.freeze({ ...envelope, object }) as unknown as SignedSystemRecordRootDescriptorEnvelopeV1;
}

export interface ValidatedSystemRecordInventoryTreeV1 {
  readonly totalRows: number;
  readonly leaves: number;
  readonly height: number;
  readonly objectDigests: ReadonlySet<string>;
}

export interface SystemRecordInventoryLoadedObjectV1 {
  readonly outcome: 'ok';
  readonly objectKind: 'inventory-internal' | 'inventory-leaf';
  readonly canonicalBytes: Uint8Array;
  /** Actual prefix + header + payload bytes consumed from the response stream. */
  readonly wireBytes: number;
}

export interface SystemRecordInventoryRejectedLoadV1 {
  readonly outcome: 'rejected';
  readonly wireBytes: number;
  readonly rejection: 'not-found' | 'invalid-response' | 'busy' | 'transport';
}

export interface SystemRecordInventoryTraversalSliceV1 {
  readonly signal?: AbortSignal;
  readonly maxRequests: number;
  readonly maxWireBytes: number;
  readonly deadlineMs: number;
  readonly nowMs?: () => number;
}

export interface SystemRecordInventoryTraversalSliceResultV1 {
  readonly status: 'paused' | 'complete' | 'rejected';
  readonly requests: number;
  readonly wireBytes: number;
  readonly rejection?: SystemRecordInventoryRejectedLoadV1['rejection'];
  readonly result?: ValidatedSystemRecordInventoryTreeV1;
}

export interface SystemRecordInventoryTraversalV1 {
  /** Advance one bounded slice. Concurrent calls are rejected. */
  advance(
    load: (
      digest: Digest32V1,
      expectedKind: 'inventory-internal' | 'inventory-leaf' | undefined,
      signal?: AbortSignal,
    ) => Promise<SystemRecordInventoryLoadedObjectV1 | SystemRecordInventoryRejectedLoadV1 | undefined>,
    slice: SystemRecordInventoryTraversalSliceV1,
  ): Promise<SystemRecordInventoryTraversalSliceResultV1>;
}

interface SystemRecordInventoryTraversalWorkV1 {
  readonly digest: Digest32V1;
  readonly depth: number;
  readonly expectedKind?: 'inventory-internal' | 'inventory-leaf';
  readonly expectedFirst?: Digest32V1;
  readonly upperExclusive?: Digest32V1;
  readonly expectedLast?: Digest32V1;
}

/** Create one opaque pinned traversal; callers must explicitly admit every bounded slice. */
export function createSystemRecordInventoryTraversalV1(
  descriptor: SystemRecordRootDescriptorObjectV1,
): SystemRecordInventoryTraversalV1 {
  const pinned = validateRootDescriptor(descriptor);
  const expectedRows = Number(parseCanonicalDecimalU64(pinned.totalRows));
  const seen = new Set<string>();
  const pending: SystemRecordInventoryTraversalWorkV1[] = [{
    digest: pinned.treeRootDigest,
    depth: 1,
  }];
  let rows = 0;
  let leaves = 0;
  let maximumDepth = 0;
  let leafDepth: number | undefined;
  let advancing = false;
  let completed: ValidatedSystemRecordInventoryTreeV1 | undefined;

  return Object.freeze({ advance });

  async function advance(
    load: (
      digest: Digest32V1,
      expectedKind: 'inventory-internal' | 'inventory-leaf' | undefined,
      signal?: AbortSignal,
    ) => Promise<SystemRecordInventoryLoadedObjectV1 | SystemRecordInventoryRejectedLoadV1 | undefined>,
    slice: SystemRecordInventoryTraversalSliceV1,
  ): Promise<SystemRecordInventoryTraversalSliceResultV1> {
    if (advancing) throw new Error('inventory traversal already has an active slice');
    if (completed !== undefined) {
      return Object.freeze({ status: 'complete', requests: 0, wireBytes: 0, result: completed });
    }
    const now = slice.nowMs ?? Date.now;
    if (!Number.isSafeInteger(slice.maxRequests) || slice.maxRequests < 1
      || slice.maxRequests > SYSTEM_RECORD_MAX_SLICE_REQUESTS
      || !Number.isSafeInteger(slice.maxWireBytes)
      || slice.maxWireBytes < framedObjectMaximum('inventory-leaf')
      || slice.maxWireBytes > SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES
      || !Number.isFinite(slice.deadlineMs)) {
      throw new Error('inventory traversal slice budget is invalid');
    }
    let requests = 0;
    let wireBytes = 0;
    advancing = true;
    try {
      while (pending.length > 0) {
        abortIfNeeded(slice.signal);
        if (now() >= slice.deadlineMs) break;
        const work = pending[pending.length - 1];
        const maximumNextBytes = framedObjectMaximum(
          work.expectedKind === 'inventory-internal' ? 'inventory-internal' : 'inventory-leaf',
        );
        if (requests >= slice.maxRequests || wireBytes + maximumNextBytes > slice.maxWireBytes) break;
        if (work.depth > SYSTEM_RECORD_MAX_TREE_HEIGHT) throw new Error('inventory tree exceeds height three');
        if (seen.has(work.digest)) throw new Error('inventory tree must not contain a cycle or duplicate path');
        if (seen.size >= SYSTEM_RECORD_MAX_INVENTORY_OBJECTS) {
          throw new Error('inventory traversal exceeds its object budget');
        }
        const artifact = await load(work.digest, work.expectedKind, slice.signal);
        requests += 1;
        abortIfNeeded(slice.signal);
        if (now() >= slice.deadlineMs) throw new Error('inventory traversal slice deadline expired during load');
        if (artifact === undefined) throw new Error(`inventory tree is missing ${work.digest}`);
        if (!Number.isSafeInteger(artifact.wireBytes)
          || artifact.wireBytes < 4
          || artifact.wireBytes > maximumNextBytes
          || wireBytes + artifact.wireBytes > slice.maxWireBytes) {
          throw new Error('inventory loader returned invalid actual wire accounting');
        }
        wireBytes += artifact.wireBytes;
        if (artifact.outcome === 'rejected') {
          if (artifact.rejection !== 'not-found'
            && artifact.rejection !== 'invalid-response'
            && artifact.rejection !== 'busy'
            && artifact.rejection !== 'transport') {
            throw new Error('inventory loader returned an invalid rejection');
          }
          return Object.freeze({
            status: 'rejected', requests, wireBytes, rejection: artifact.rejection,
          });
        }
        if (artifact.objectKind !== 'inventory-leaf' && artifact.objectKind !== 'inventory-internal') {
          throw new Error('inventory loader returned an invalid object kind');
        }
        if (!(artifact.canonicalBytes instanceof Uint8Array)
          || artifact.canonicalBytes.byteLength > SYSTEM_RECORD_OBJECT_CAPS_V1[artifact.objectKind]
          || artifact.wireBytes < 4 + artifact.canonicalBytes.byteLength) {
          throw new Error('inventory loader returned an over-cap object');
        }
        if (work.expectedKind !== undefined && artifact.objectKind !== work.expectedKind) {
          throw new Error('inventory child kind mismatch');
        }
        const root = work.depth === 1;
        const object = artifact.objectKind === 'inventory-leaf'
          ? parseCanonicalSystemRecordInventoryLeafObjectV1(artifact.canonicalBytes, pinned.networkId, root)
          : parseCanonicalSystemRecordInventoryInternalObjectV1(artifact.canonicalBytes, root);
        const actualDigest = artifact.objectKind === 'inventory-leaf'
          ? computeSystemRecordInventoryLeafDigestV1(object as SystemRecordInventoryLeafObjectV1, pinned.networkId, root)
          : computeSystemRecordInventoryInternalDigestV1(object as SystemRecordInventoryInternalObjectV1, root);
        if (actualDigest !== work.digest) throw new Error('inventory object digest mismatch');
        const first = object.firstKeyHash;
        const last = object.lastKeyHash;
        if (work.expectedFirst !== undefined && first !== work.expectedFirst) {
          throw new Error('inventory child lower range mismatch');
        }
        if (work.upperExclusive !== undefined && last !== undefined && last >= work.upperExclusive) {
          throw new Error('inventory child range overlaps its next sibling');
        }
        if (work.expectedLast !== undefined && last !== work.expectedLast) {
          throw new Error('inventory final child range mismatch');
        }
        pending.pop();
        seen.add(work.digest);
        maximumDepth = Math.max(maximumDepth, work.depth);
        if (artifact.objectKind === 'inventory-leaf') {
          const leaf = object as SystemRecordInventoryLeafObjectV1;
          if (leafDepth !== undefined && work.depth !== leafDepth) {
            throw new Error('inventory tree leaves must all have the same depth');
          }
          leafDepth = work.depth;
          leaves += 1;
          rows += leaf.rows.length;
          if (leaves > SYSTEM_RECORD_MAX_INVENTORY_LEAVES
            || rows > SYSTEM_RECORD_MAX_INVENTORY_RECORDS
            || rows > expectedRows) {
            throw new Error('inventory traversal exceeds its leaf/row bound');
          }
        } else {
          if (work.depth === SYSTEM_RECORD_MAX_TREE_HEIGHT) {
            throw new Error('internal node appears below height bound');
          }
          const internal = object as SystemRecordInventoryInternalObjectV1;
          for (let index = internal.entries.length - 1; index >= 0; index -= 1) {
            const entry = internal.entries[index];
            pending.push({
              digest: entry.childDigest,
              depth: work.depth + 1,
              expectedKind: entry.childKind,
              expectedFirst: entry.separatorKeyHash,
              ...(index === internal.entries.length - 1 ? {} : {
                upperExclusive: internal.entries[index + 1].separatorKeyHash,
              }),
              ...(index === internal.entries.length - 1 ? { expectedLast: internal.lastKeyHash } : {}),
            });
          }
        }
      }
      if (pending.length !== 0) {
        return Object.freeze({ status: 'paused', requests, wireBytes });
      }
      if (rows !== expectedRows) throw new Error('inventory traversal total does not match descriptor.totalRows');
      if (rows === 0 && leaves !== 1) throw new Error('empty inventory must use one root leaf');
      completed = Object.freeze({
        totalRows: rows,
        leaves,
        height: maximumDepth,
        objectDigests: new Set(seen),
      });
      return Object.freeze({ status: 'complete', requests, wireBytes, result: completed });
    } finally {
      advancing = false;
    }
  }
}

function framedObjectMaximum(objectKind: 'inventory-internal' | 'inventory-leaf'): number {
  return 4 + SYSTEM_RECORD_MAX_HEADER_BYTES + SYSTEM_RECORD_OBJECT_CAPS_V1[objectKind];
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('inventory traversal aborted');
}

/** Pick the deterministic split nearest half encoded bytes while preserving minima. */
export function chooseSystemRecordByteAwareSplitIndexV1(
  encodedEntryBytes: readonly number[],
  minimumLeft: number,
  minimumRight: number,
): number {
  if (!Number.isInteger(minimumLeft) || !Number.isInteger(minimumRight)
    || minimumLeft < 1 || minimumRight < 1
    || encodedEntryBytes.length < minimumLeft + minimumRight) {
    throw new Error('split cardinality cannot preserve occupancy');
  }
  if (encodedEntryBytes.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('split byte lengths must be positive safe integers');
  }
  const total = encodedEntryBytes.reduce((sum, value) => sum + value, 0);
  let prefix = encodedEntryBytes.slice(0, minimumLeft).reduce((sum, value) => sum + value, 0);
  let best = minimumLeft;
  let bestDistance = Math.abs(total - 2 * prefix);
  for (let index = minimumLeft + 1; index <= encodedEntryBytes.length - minimumRight; index += 1) {
    prefix += encodedEntryBytes[index - 1];
    const distance = Math.abs(total - 2 * prefix);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

export type SystemRecordRebalanceChoiceV1 = 'borrow-left' | 'borrow-right' | 'merge-left' | 'merge-right';

export function chooseSystemRecordRebalanceV1(
  leftCount: number | undefined,
  rightCount: number | undefined,
  minimum: number,
): SystemRecordRebalanceChoiceV1 {
  if (leftCount !== undefined && leftCount > minimum) return 'borrow-left';
  if (rightCount !== undefined && rightCount > minimum) return 'borrow-right';
  if (leftCount !== undefined) return 'merge-left';
  if (rightCount !== undefined) return 'merge-right';
  throw new Error('rebalance requires an adjacent sibling');
}

export interface SystemRecordInventoryCowUpdateAccountingV1 {
  readonly leafObjects: number;
  readonly internalObjects: number;
  readonly rootObjects: number;
  readonly descriptorObjects: number;
  readonly encodedBytes: number;
}

export function assertSystemRecordInventoryCowUpdateBoundV1(
  accounting: SystemRecordInventoryCowUpdateAccountingV1,
): void {
  const values = [
    accounting.leafObjects,
    accounting.internalObjects,
    accounting.rootObjects,
    accounting.descriptorObjects,
    accounting.encodedBytes,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('COW accounting values must be non-negative safe integers');
  }
  const objects = accounting.leafObjects + accounting.internalObjects
    + accounting.rootObjects + accounting.descriptorObjects;
  if (accounting.leafObjects > 2 || accounting.internalObjects > 2
    || accounting.rootObjects > 1 || accounting.descriptorObjects !== 1
    || objects > SYSTEM_RECORD_MAX_TREE_UPDATE_OBJECTS
    || accounting.encodedBytes > SYSTEM_RECORD_MAX_TREE_UPDATE_BYTES) {
    throw new Error('inventory update exceeds the six-object/1-MiB COW bound');
  }
}

export const SYSTEM_RECORD_INVENTORY_REBALANCE_TARGETS_V1 = Object.freeze({
  leafBytes: SYSTEM_RECORD_LEAF_TARGET_BYTES,
  internalBytes: SYSTEM_RECORD_INTERNAL_TARGET_BYTES,
});

export interface SystemRecordInventoryStoredObjectV1 {
  readonly objectKind: 'inventory-leaf' | 'inventory-internal';
  readonly object: SystemRecordInventoryObjectV1;
  readonly canonicalBytes: Uint8Array;
}

export interface SystemRecordInventoryTreeSnapshotV1 {
  readonly networkId: NetworkIdV1;
  readonly descriptor: SystemRecordRootDescriptorObjectV1;
  readonly descriptorDigest: Digest32V1;
  readonly objects: ReadonlyMap<Digest32V1, SystemRecordInventoryStoredObjectV1>;
}

export interface SystemRecordInventoryCowWriteV1 extends SystemRecordInventoryStoredObjectV1 {
  readonly digest: Digest32V1;
  readonly role: 'leaf' | 'internal' | 'root';
}

export type SystemRecordInventoryMutationV1 =
  | { readonly operation: 'upsert'; readonly row: SystemRecordInventoryRowV1 }
  | { readonly operation: 'delete'; readonly stableKeyHash: Digest32V1; readonly peerId: string };

export interface SystemRecordInventoryCowUpdateV1 {
  readonly changed: boolean;
  readonly descriptor: SystemRecordRootDescriptorObjectV1;
  readonly descriptorDigest: Digest32V1;
  readonly writes: readonly SystemRecordInventoryCowWriteV1[];
  readonly descriptorBytes?: Uint8Array;
  readonly accounting: SystemRecordInventoryCowUpdateAccountingV1;
  readonly reusedObjectDigests: ReadonlySet<Digest32V1>;
  readonly loadedObjectDigests: ReadonlySet<Digest32V1>;
}

/** Build the first immutable tree; subsequent publications must use the COW updater. */
export function buildSystemRecordInventoryTreeV1(
  networkId: NetworkIdV1,
  rows: readonly SystemRecordInventoryRowV1[],
  epoch: DecimalU64V1 = '0' as DecimalU64V1,
): SystemRecordInventoryTreeSnapshotV1 {
  assertNetworkIdV1(networkId);
  assertCanonicalDecimalU64(epoch);
  if (!Array.isArray(rows) || rows.length > SYSTEM_RECORD_MAX_INVENTORY_RECORDS) {
    throw new Error('initial inventory exceeds the V1 row bound');
  }
  const sorted = [...rows];
  for (const row of sorted) validateInventoryRow(row, networkId);
  sorted.sort(compareRows);
  for (let index = 1; index < sorted.length; index += 1) {
    if (compareRows(sorted[index - 1], sorted[index]) >= 0) {
      throw new Error('initial inventory rows must be stable-key unique');
    }
  }
  const objects = new Map<Digest32V1, SystemRecordInventoryStoredObjectV1>();
  let rootDigest: Digest32V1;
  if (sorted.length <= SYSTEM_RECORD_LEAF_MAX_ROWS) {
    rootDigest = storeLeaf(sorted, true).digest;
  } else {
    const leafGroups = partitionByTarget(
      sorted,
      SYSTEM_RECORD_LEAF_MIN_ROWS,
      SYSTEM_RECORD_LEAF_MAX_ROWS,
      SYSTEM_RECORD_LEAF_TARGET_BYTES,
      (row) => encodeSystemRecordInventoryRowV1(networkId, row).byteLength,
    );
    if (leafGroups.length > SYSTEM_RECORD_MAX_INVENTORY_LEAVES) {
      throw new Error('initial inventory exceeds the V1 leaf bound');
    }
    const leafRefs = leafGroups.map((group) => storeLeaf(group, false));
    if (leafRefs.length <= SYSTEM_RECORD_ROOT_MAX_ENTRIES) {
      rootDigest = storeInternal(leafRefs, true).digest;
    } else {
      const internalGroups = partitionByTarget(
        leafRefs,
        SYSTEM_RECORD_INTERNAL_MIN_ENTRIES,
        SYSTEM_RECORD_INTERNAL_MAX_ENTRIES,
        SYSTEM_RECORD_INTERNAL_TARGET_BYTES,
        () => SYSTEM_RECORD_MAX_INTERNAL_ENTRY_BYTES,
      );
      const internalRefs = internalGroups.map((group) => storeInternal(group, false));
      if (internalRefs.length > SYSTEM_RECORD_ROOT_MAX_ENTRIES) {
        throw new Error('initial inventory exceeds the V1 root fanout');
      }
      rootDigest = storeInternal(internalRefs, true).digest;
    }
  }
  const descriptor: SystemRecordRootDescriptorObjectV1 = {
    objectType: 'root-descriptor',
    kind: SYSTEM_RECORD_KIND_V1,
    networkId,
    epoch,
    version: '0' as DecimalU64V1,
    treeRootDigest: rootDigest,
    totalRows: rows.length.toString() as DecimalU64V1,
  };
  return Object.freeze({
    networkId,
    descriptor: validateRootDescriptor(descriptor),
    descriptorDigest: computeSystemRecordRootDescriptorDigestV1(descriptor),
    objects,
  });

  function storeLeaf(group: readonly SystemRecordInventoryRowV1[], root: boolean): CowChildRef {
    const object = makeLeafObject(networkId, group);
    const canonicalBytes = canonicalizeSystemRecordInventoryLeafObjectV1(object, networkId, root);
    const digest = computeSystemRecordInventoryLeafDigestV1(object, networkId, root);
    objects.set(digest, Object.freeze({ objectKind: 'inventory-leaf', object, canonicalBytes }));
    return { digest, objectKind: 'inventory-leaf', first: object.firstKeyHash, last: object.lastKeyHash };
  }

  function storeInternal(group: readonly CowChildRef[], root: boolean): CowChildRef {
    const object = makeInternalObject(group);
    const canonicalBytes = canonicalizeSystemRecordInventoryInternalObjectV1(object, root);
    const digest = computeSystemRecordInventoryInternalDigestV1(object, root);
    objects.set(digest, Object.freeze({ objectKind: 'inventory-internal', object, canonicalBytes }));
    return { digest, objectKind: 'inventory-internal', first: object.firstKeyHash, last: object.lastKeyHash };
  }
}

interface CowChildRef {
  readonly digest: Digest32V1;
  readonly objectKind: 'inventory-leaf' | 'inventory-internal';
  readonly first?: Digest32V1;
  readonly last?: Digest32V1;
}

interface CowPathFrame {
  readonly digest: Digest32V1;
  readonly object: SystemRecordInventoryInternalObjectV1;
  readonly childIndex: number;
  readonly root: boolean;
}

/**
 * Apply one localized immutable mutation. Only the search path and the adjacent siblings
 * needed by the deterministic lend-before-merge rule are loaded; every returned write is
 * derived from canonical bytes, never reported by the caller.
 */
export function updateSystemRecordInventoryTreeV1(
  snapshot: SystemRecordInventoryTreeSnapshotV1,
  mutation: SystemRecordInventoryMutationV1,
): SystemRecordInventoryCowUpdateV1 {
  const descriptor = validateRootDescriptor(snapshot.descriptor);
  if (descriptor.networkId !== snapshot.networkId
    || computeSystemRecordRootDescriptorDigestV1(descriptor) !== snapshot.descriptorDigest) {
    throw new Error('inventory snapshot descriptor binding is invalid');
  }
  const targetKey = mutation.operation === 'upsert' ? mutation.row.stableKeyHash : mutation.stableKeyHash;
  const targetPeer = mutation.operation === 'upsert' ? mutation.row.peerId : mutation.peerId;
  assertCanonicalDigest(targetKey);
  assertCanonicalSystemRecordPeerIdV1(targetPeer);
  if (targetKey !== computeSystemRecordStableKeyHashV1(snapshot.networkId, targetPeer)) {
    throw new Error('inventory mutation key does not bind networkId/peerId');
  }
  if (mutation.operation === 'upsert') validateInventoryRow(mutation.row, snapshot.networkId);

  const loaded = new Set<Digest32V1>();
  const path: CowPathFrame[] = [];
  let currentDigest = descriptor.treeRootDigest;
  let depth = 1;
  let leaf: SystemRecordInventoryLeafObjectV1;
  while (true) {
    const stored = loadObject(currentDigest, depth === 1);
    if (stored.objectKind === 'inventory-leaf') {
      leaf = stored.object as SystemRecordInventoryLeafObjectV1;
      break;
    }
    const internal = stored.object as SystemRecordInventoryInternalObjectV1;
    const childIndex = findChildIndex(internal.entries, targetKey);
    path.push({ digest: currentDigest, object: internal, childIndex, root: depth === 1 });
    currentDigest = internal.entries[childIndex].childDigest;
    depth += 1;
    if (depth > SYSTEM_RECORD_MAX_TREE_HEIGHT) throw new Error('inventory mutation path exceeds height bound');
  }
  const rows = leaf.rows.map((encoded) => decodeInventoryRowBase64UrlV1(snapshot.networkId, encoded));
  const index = findRowIndex(rows, targetKey, targetPeer);
  const exists = index < rows.length && rows[index].stableKeyHash === targetKey;
  if (exists && rows[index].peerId !== targetPeer) throw new Error('stable-key hash collision');
  if (mutation.operation === 'delete' && !exists) return unchanged();
  if (mutation.operation === 'upsert' && exists
    && Buffer.from(encodeSystemRecordInventoryRowV1(snapshot.networkId, rows[index])).equals(
      Buffer.from(encodeSystemRecordInventoryRowV1(snapshot.networkId, mutation.row)),
    )) return unchanged();
  if (mutation.operation === 'upsert') rows.splice(index, exists ? 1 : 0, mutation.row);
  else rows.splice(index, 1);

  const writes: SystemRecordInventoryCowWriteV1[] = [];
  // Bounded write overlay only. The caller persists these objects before publishing the
  // returned descriptor; copying the complete provider cache would defeat COW locality.
  const nextObjects = new Map<Digest32V1, SystemRecordInventoryStoredObjectV1>();
  let replacement: CowChildRef[];
  let parentReplaceIndex = path.at(-1)?.childIndex ?? 0;
  let parentReplaceCount = 1;
  const leafIsRoot = path.length === 0;
  if (leafIsRoot) {
    if (rows.length <= SYSTEM_RECORD_LEAF_MAX_ROWS) {
      replacement = [persistLeaf(rows, true, 'root')];
      return finish(replacement[0].digest, rows.length);
    }
    const split = chooseSystemRecordByteAwareSplitIndexV1(
      rows.map((row) => encodeSystemRecordInventoryRowV1(snapshot.networkId, row).byteLength),
      SYSTEM_RECORD_LEAF_MIN_ROWS,
      SYSTEM_RECORD_LEAF_MIN_ROWS,
    );
    const children = [persistLeaf(rows.slice(0, split), false, 'leaf'), persistLeaf(rows.slice(split), false, 'leaf')];
    const root = persistInternal(children, true, 'root');
    return finish(root.digest, rows.length);
  }

  if (rows.length > SYSTEM_RECORD_LEAF_MAX_ROWS) {
    const split = chooseSystemRecordByteAwareSplitIndexV1(
      rows.map((row) => encodeSystemRecordInventoryRowV1(snapshot.networkId, row).byteLength),
      SYSTEM_RECORD_LEAF_MIN_ROWS,
      SYSTEM_RECORD_LEAF_MIN_ROWS,
    );
    replacement = [
      persistLeaf(rows.slice(0, split), false, 'leaf'),
      persistLeaf(rows.slice(split), false, 'leaf'),
    ];
  } else if (rows.length >= SYSTEM_RECORD_LEAF_MIN_ROWS) {
    replacement = [persistLeaf(rows, false, 'leaf')];
  } else {
    const parent = path.at(-1)!;
    const leftIndex = parent.childIndex > 0 ? parent.childIndex - 1 : undefined;
    const rightIndex = parent.childIndex + 1 < parent.object.entries.length
      ? parent.childIndex + 1
      : undefined;
    const leftRows = leftIndex === undefined ? undefined : loadLeafRows(leftIndex);
    const rightRows = leftRows !== undefined && leftRows.length > SYSTEM_RECORD_LEAF_MIN_ROWS
      ? undefined
      : rightIndex === undefined ? undefined : loadLeafRows(rightIndex);
    const siblingIsLeft = leftRows !== undefined && (leftRows.length > SYSTEM_RECORD_LEAF_MIN_ROWS
      || rightRows === undefined || rightRows.length <= SYSTEM_RECORD_LEAF_MIN_ROWS);
    const siblingIndex = siblingIsLeft ? leftIndex! : rightIndex!;
    const siblingRows = siblingIsLeft ? leftRows! : rightRows!;
    parentReplaceIndex = Math.min(parent.childIndex, siblingIndex);
    parentReplaceCount = 2;
    if (siblingRows.length > SYSTEM_RECORD_LEAF_MIN_ROWS) {
      if (siblingIsLeft) rows.unshift(siblingRows.pop()!);
      else rows.push(siblingRows.shift()!);
      replacement = siblingIsLeft
        ? [persistLeaf(siblingRows, false, 'leaf'), persistLeaf(rows, false, 'leaf')]
        : [persistLeaf(rows, false, 'leaf'), persistLeaf(siblingRows, false, 'leaf')];
    } else {
      const merged = siblingIsLeft ? [...siblingRows, ...rows] : [...rows, ...siblingRows];
      replacement = [persistLeaf(merged, false, 'leaf')];
    }

    function loadLeafRows(index: number): SystemRecordInventoryRowV1[] {
      const siblingEntry = parent.object.entries[index];
      if (siblingEntry?.childKind !== 'inventory-leaf') throw new Error('leaf rebalance sibling is unavailable');
      const sibling = loadObject(siblingEntry.childDigest, false).object as SystemRecordInventoryLeafObjectV1;
      return sibling.rows.map((encoded) => decodeInventoryRowBase64UrlV1(snapshot.networkId, encoded));
    }
  }

  let frame = path.pop()!;
  let parentEntries = replaceChildEntries(frame.object.entries, parentReplaceIndex, parentReplaceCount, replacement);
  if (frame.root) return finishRootEntries(parentEntries, rowsDelta());

  let nextParentRefs: CowChildRef[];
  if (parentEntries.length > SYSTEM_RECORD_INTERNAL_MAX_ENTRIES) {
    const split = chooseSystemRecordByteAwareSplitIndexV1(
      parentEntries.map((entry) => canonicalizeJsonBytes(entry as unknown as CanonicalJsonValue).byteLength),
      SYSTEM_RECORD_INTERNAL_MIN_ENTRIES,
      SYSTEM_RECORD_INTERNAL_MIN_ENTRIES,
    );
    nextParentRefs = [
      persistInternalEntries(parentEntries.slice(0, split), false, 'internal'),
      persistInternalEntries(parentEntries.slice(split), false, 'internal'),
    ];
  } else if (parentEntries.length >= SYSTEM_RECORD_INTERNAL_MIN_ENTRIES) {
    nextParentRefs = [persistInternalEntries(parentEntries, false, 'internal')];
  } else {
    const rootFrame = path.pop();
    if (rootFrame === undefined || !rootFrame.root) throw new Error('non-root internal node lacks root parent');
    const rootParent = rootFrame;
    const leftIndex = rootParent.childIndex > 0 ? rootParent.childIndex - 1 : undefined;
    const rightIndex = rootParent.childIndex + 1 < rootParent.object.entries.length
      ? rootParent.childIndex + 1
      : undefined;
    const left = leftIndex === undefined ? undefined : loadInternalSibling(leftIndex);
    const right = left !== undefined && left.entries.length > SYSTEM_RECORD_INTERNAL_MIN_ENTRIES
      ? undefined
      : rightIndex === undefined ? undefined : loadInternalSibling(rightIndex);
    const siblingIsLeft = left !== undefined && (left.entries.length > SYSTEM_RECORD_INTERNAL_MIN_ENTRIES
      || right === undefined || right.entries.length <= SYSTEM_RECORD_INTERNAL_MIN_ENTRIES);
    const siblingIndex = siblingIsLeft ? leftIndex! : rightIndex!;
    const sibling = siblingIsLeft ? left! : right!;
    let rootReplaceIndex = Math.min(rootParent.childIndex, siblingIndex);
    if (sibling.entries.length > SYSTEM_RECORD_INTERNAL_MIN_ENTRIES) {
      const siblingEntries = [...sibling.entries];
      if (siblingIsLeft) parentEntries.unshift(siblingEntries.pop()!);
      else parentEntries.push(siblingEntries.shift()!);
      nextParentRefs = siblingIsLeft
        ? [persistInternalEntries(siblingEntries, false, 'internal'), persistInternalEntries(parentEntries, false, 'internal')]
        : [persistInternalEntries(parentEntries, false, 'internal'), persistInternalEntries(siblingEntries, false, 'internal')];
    } else {
      const merged = siblingIsLeft ? [...sibling.entries, ...parentEntries] : [...parentEntries, ...sibling.entries];
      const collapsesRoot = rootParent.object.entries.length === 2;
      nextParentRefs = [persistInternalEntries(
        merged,
        collapsesRoot,
        collapsesRoot ? 'root' : 'internal',
      )];
    }
    const rootEntries = replaceChildEntries(rootParent.object.entries, rootReplaceIndex, 2, nextParentRefs);
    if (rootEntries.length === 1) return finish(rootEntries[0].childDigest, rowsDelta());
    return finishRootEntries(rootEntries, rowsDelta());

    function loadInternalSibling(index: number): SystemRecordInventoryInternalObjectV1 {
      const siblingEntry = rootParent.object.entries[index];
      if (siblingEntry?.childKind !== 'inventory-internal') {
        throw new Error('internal rebalance sibling is unavailable');
      }
      return loadObject(siblingEntry.childDigest, false).object as SystemRecordInventoryInternalObjectV1;
    }
  }

  const rootFrame = path.pop();
  if (rootFrame === undefined || !rootFrame.root) throw new Error('inventory height exceeds the V1 update model');
  const rootEntries = replaceChildEntries(rootFrame.object.entries, rootFrame.childIndex, 1, nextParentRefs);
  return finishRootEntries(rootEntries, rowsDelta());

  function rowsDelta(): number {
    return Number(parseCanonicalDecimalU64(descriptor.totalRows))
      + (mutation.operation === 'upsert' && !exists ? 1 : mutation.operation === 'delete' ? -1 : 0);
  }

  function loadObject(digest: Digest32V1, root: boolean): SystemRecordInventoryStoredObjectV1 {
    const stored = snapshot.objects.get(digest);
    if (stored === undefined) throw new Error(`inventory snapshot is missing ${digest}`);
    const actual = stored.objectKind === 'inventory-leaf'
      ? computeSystemRecordInventoryLeafDigestV1(stored.object as SystemRecordInventoryLeafObjectV1, snapshot.networkId, root)
      : computeSystemRecordInventoryInternalDigestV1(stored.object as SystemRecordInventoryInternalObjectV1, root);
    if (actual !== digest) throw new Error('inventory snapshot object digest is invalid');
    loaded.add(digest);
    return stored;
  }

  function persistLeaf(
    nextRows: readonly SystemRecordInventoryRowV1[],
    root: boolean,
    role: SystemRecordInventoryCowWriteV1['role'],
  ): CowChildRef {
    const object = makeLeafObject(snapshot.networkId, nextRows);
    const bytes = canonicalizeSystemRecordInventoryLeafObjectV1(object, snapshot.networkId, root);
    const digest = computeSystemRecordInventoryLeafDigestV1(object, snapshot.networkId, root);
    persist(digest, 'inventory-leaf', object, bytes, role);
    return { digest, objectKind: 'inventory-leaf', first: object.firstKeyHash, last: object.lastKeyHash };
  }

  function persistInternal(
    children: readonly CowChildRef[],
    root: boolean,
    role: SystemRecordInventoryCowWriteV1['role'],
  ): CowChildRef {
    return persistInternalObject(makeInternalObject(children), root, role);
  }

  function persistInternalEntries(
    entries: readonly SystemRecordInventoryInternalEntryV1[],
    root: boolean,
    role: SystemRecordInventoryCowWriteV1['role'],
  ): CowChildRef {
    const lastChild = childRef(entries.at(-1)!);
    const object: SystemRecordInventoryInternalObjectV1 = {
      objectType: 'inventory-internal',
      firstKeyHash: entries[0].separatorKeyHash,
      lastKeyHash: lastChild.last!,
      entries: Object.freeze([...entries]),
    };
    return persistInternalObject(object, root, role);
  }

  function persistInternalObject(
    object: SystemRecordInventoryInternalObjectV1,
    root: boolean,
    role: SystemRecordInventoryCowWriteV1['role'],
  ): CowChildRef {
    const bytes = canonicalizeSystemRecordInventoryInternalObjectV1(object, root);
    const digest = computeSystemRecordInventoryInternalDigestV1(object, root);
    persist(digest, 'inventory-internal', object, bytes, role);
    return { digest, objectKind: 'inventory-internal', first: object.firstKeyHash, last: object.lastKeyHash };
  }

  function persist(
    digest: Digest32V1,
    objectKind: SystemRecordInventoryStoredObjectV1['objectKind'],
    object: SystemRecordInventoryObjectV1,
    canonicalBytes: Uint8Array,
    role: SystemRecordInventoryCowWriteV1['role'],
  ): void {
    const stored = Object.freeze({ objectKind, object, canonicalBytes });
    nextObjects.set(digest, stored);
    if (!snapshot.objects.has(digest) && !writes.some((write) => write.digest === digest)) {
      writes.push(Object.freeze({ digest, objectKind, object, canonicalBytes, role }));
    }
  }

  function childRef(entry: SystemRecordInventoryInternalEntryV1): CowChildRef {
    const stored = nextObjects.get(entry.childDigest) ?? snapshot.objects.get(entry.childDigest);
    if (stored === undefined) throw new Error('updated inventory references a missing child');
    if (snapshot.objects.has(entry.childDigest)) loaded.add(entry.childDigest);
    const object = stored.object;
    return {
      digest: entry.childDigest,
      objectKind: entry.childKind,
      first: object.firstKeyHash,
      last: object.lastKeyHash,
    };
  }

  function finishRootEntries(entries: readonly SystemRecordInventoryInternalEntryV1[], totalRows: number): SystemRecordInventoryCowUpdateV1 {
    if (entries.length === 1) return finish(entries[0].childDigest, totalRows);
    if (entries.length <= SYSTEM_RECORD_ROOT_MAX_ENTRIES) {
      const root = persistInternalEntries(entries, true, 'root');
      return finish(root.digest, totalRows);
    }
    const split = chooseSystemRecordByteAwareSplitIndexV1(
      entries.map((entry) => canonicalizeJsonBytes(entry as unknown as CanonicalJsonValue).byteLength),
      SYSTEM_RECORD_INTERNAL_MIN_ENTRIES,
      SYSTEM_RECORD_INTERNAL_MIN_ENTRIES,
    );
    const children = [
      persistInternalEntries(entries.slice(0, split), false, 'internal'),
      persistInternalEntries(entries.slice(split), false, 'internal'),
    ];
    const root = persistInternal(children, true, 'root');
    return finish(root.digest, totalRows);
  }

  function finish(rootDigest: Digest32V1, totalRows: number): SystemRecordInventoryCowUpdateV1 {
    const nextVersion = parseCanonicalDecimalU64(descriptor.version) + 1n;
    if (nextVersion > 0xffff_ffff_ffff_ffffn) throw new Error('root descriptor version overflow');
    const nextDescriptor: SystemRecordRootDescriptorObjectV1 = {
      objectType: 'root-descriptor', kind: SYSTEM_RECORD_KIND_V1, networkId: snapshot.networkId,
      epoch: descriptor.epoch, version: nextVersion.toString() as DecimalU64V1,
      priorRootDigest: snapshot.descriptorDigest, treeRootDigest: rootDigest,
      totalRows: totalRows.toString() as DecimalU64V1,
    };
    const descriptorBytes = canonicalizeSystemRecordRootDescriptorObjectV1(nextDescriptor);
    const accounting: SystemRecordInventoryCowUpdateAccountingV1 = {
      leafObjects: writes.filter((write) => write.role === 'leaf').length,
      internalObjects: writes.filter((write) => write.role === 'internal').length,
      rootObjects: writes.filter((write) => write.role === 'root').length,
      descriptorObjects: 1,
      encodedBytes: descriptorBytes.byteLength + writes.reduce((sum, write) => sum + write.canonicalBytes.byteLength, 0),
    };
    assertSystemRecordInventoryCowUpdateBoundV1(accounting);
    const reused = new Set<Digest32V1>();
    if (snapshot.objects.has(rootDigest)) reused.add(rootDigest);
    for (const write of writes) {
      if (write.objectKind !== 'inventory-internal') continue;
      for (const entry of (write.object as SystemRecordInventoryInternalObjectV1).entries) {
        if (snapshot.objects.has(entry.childDigest)) reused.add(entry.childDigest);
      }
    }
    const validatedDescriptor = validateRootDescriptor(nextDescriptor);
    const descriptorDigest = computeSystemRecordRootDescriptorDigestV1(nextDescriptor);
    return Object.freeze({ changed: true, descriptor: validatedDescriptor, descriptorDigest,
      writes: Object.freeze(writes),
      descriptorBytes, accounting: Object.freeze(accounting), reusedObjectDigests: reused, loadedObjectDigests: loaded });
  }

  function unchanged(): SystemRecordInventoryCowUpdateV1 {
    return Object.freeze({ changed: false, descriptor, descriptorDigest: snapshot.descriptorDigest,
      writes: Object.freeze([]),
      accounting: Object.freeze({ leafObjects: 0, internalObjects: 0, rootObjects: 0, descriptorObjects: 0, encodedBytes: 0 }),
      // A no-op publishes no descriptor, so it has no reuse closure to report. Enumerating the
      // complete snapshot here would turn an otherwise path-bounded lookup into O(tree size).
      reusedObjectDigests: new Set<Digest32V1>(), loadedObjectDigests: loaded });
  }
}

function makeLeafObject(
  networkId: NetworkIdV1,
  rows: readonly SystemRecordInventoryRowV1[],
): SystemRecordInventoryLeafObjectV1 {
  const encoded = rows.map((row) => encodeInventoryRowBase64UrlV1(networkId, row));
  return rows.length === 0
    ? Object.freeze({ objectType: 'inventory-leaf', rows: Object.freeze(encoded) })
    : Object.freeze({ objectType: 'inventory-leaf', firstKeyHash: rows[0].stableKeyHash,
        lastKeyHash: rows.at(-1)!.stableKeyHash, rows: Object.freeze(encoded) });
}

function makeInternalObject(children: readonly CowChildRef[]): SystemRecordInventoryInternalObjectV1 {
  if (children.length === 0 || children.some((child) => child.first === undefined || child.last === undefined)) {
    throw new Error('internal inventory node requires nonempty ranged children');
  }
  const childKind = children[0].objectKind;
  if (children.some((child) => child.objectKind !== childKind)) throw new Error('internal children must have one kind');
  return Object.freeze({
    objectType: 'inventory-internal', firstKeyHash: children[0].first!, lastKeyHash: children.at(-1)!.last!,
    entries: Object.freeze(children.map((child) => Object.freeze({
      separatorKeyHash: child.first!, childDigest: child.digest, childKind,
    }))),
  });
}

function replaceChildEntries(
  entries: readonly SystemRecordInventoryInternalEntryV1[],
  index: number,
  count: number,
  replacements: readonly CowChildRef[],
): SystemRecordInventoryInternalEntryV1[] {
  const next = [...entries];
  next.splice(index, count, ...replacements.map((child) => ({
    separatorKeyHash: child.first!, childDigest: child.digest, childKind: child.objectKind,
  })));
  return next;
}

function findChildIndex(entries: readonly SystemRecordInventoryInternalEntryV1[], key: Digest32V1): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle].separatorKeyHash <= key) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function findRowIndex(rows: readonly SystemRecordInventoryRowV1[], key: Digest32V1, peerId: string): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const candidate = rows[middle];
    const comparison = candidate.stableKeyHash === key
      ? candidate.peerId === peerId ? 0 : (() => { throw new Error('stable-key hash collision'); })()
      : candidate.stableKeyHash < key ? -1 : 1;
    if (comparison < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function partitionByTarget<T>(
  values: readonly T[],
  minimum: number,
  maximum: number,
  targetBytes: number,
  encodedBytes: (value: T) => number,
): T[][] {
  if (values.length < minimum) throw new Error('partition cannot meet minimum occupancy');
  const totalBytes = values.reduce((sum, value) => sum + encodedBytes(value), 0);
  const minimumGroups = Math.ceil(values.length / maximum);
  const maximumGroups = Math.floor(values.length / minimum);
  const groups = Math.max(minimumGroups, Math.min(maximumGroups, Math.max(1, Math.round(totalBytes / targetBytes))));
  const base = Math.floor(values.length / groups);
  const remainder = values.length % groups;
  const result: T[][] = [];
  let offset = 0;
  for (let index = 0; index < groups; index += 1) {
    const count = base + (index < remainder ? 1 : 0);
    result.push(values.slice(offset, offset + count));
    offset += count;
  }
  return result;
}


function validateInventoryRow(row: SystemRecordInventoryRowV1, networkId?: NetworkIdV1): void {
  const expected = [
    'stableKeyHash', 'peerId', 'authoritySequence', 'version', 'headDigest',
    ...(row.conflictEvidenceDigest === undefined ? [] : ['conflictEvidenceDigest']),
    'tombstone', 'quarantined',
  ];
  snapshotExactDataRecord(row, expected, 'inventory row');
  assertCanonicalDigest(row.stableKeyHash);
  try {
    assertCanonicalSystemRecordPeerIdV1(row.peerId);
  } catch {
    throw new Error('inventory row peerId is not canonical');
  }
  if (parseCanonicalDecimalU64(row.authoritySequence) > SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX) {
    throw new Error('inventory row authoritySequence exceeds the V1 cap');
  }
  assertCanonicalDecimalU64(row.version);
  assertCanonicalDigest(row.headDigest);
  if (row.conflictEvidenceDigest !== undefined) {
    assertCanonicalDigest(row.conflictEvidenceDigest);
    if (!row.quarantined) throw new Error('conflict evidence may appear only on quarantined rows');
  }
  if (typeof row.tombstone !== 'boolean' || typeof row.quarantined !== 'boolean') {
    throw new Error('inventory row flags must be booleans');
  }
  if (networkId !== undefined && row.stableKeyHash !== computeSystemRecordStableKeyHashV1(networkId, row.peerId)) {
    throw new Error('inventory row stable key hash does not bind networkId/peerId');
  }
}

function compareRows(left: SystemRecordInventoryRowV1, right: SystemRecordInventoryRowV1): number {
  if (left.stableKeyHash !== right.stableKeyHash) return left.stableKeyHash < right.stableKeyHash ? -1 : 1;
  if (left.peerId === right.peerId) return 0;
  // Same hash with a different peer is a collision refusal, not a secondary bucket.
  throw new Error('stable-key hash collision between different canonical peers');
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  return value as Record<string, unknown>;
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

function concatBytes(...values: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((sum, value) => sum + value.byteLength, 0));
  let offset = 0;
  for (const value of values) { output.set(value, offset); offset += value.byteLength; }
  return output;
}
