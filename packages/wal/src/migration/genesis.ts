import { blake3 } from '@noble/hashes/blake3.js';
import { compareCanonicalCbor, encodeCanonicalCbor } from '../protocol/canonical-cbor.js';
import { decodeProtocolTuple, encodeProtocolTuple } from '../protocol/codec.js';
import { protocolTupleId } from '../protocol/hashes.js';
import {
  signSingleProtocolTuple,
  signThresholdProtocolTuple,
  type WalEip191Signer,
} from '../protocol/signatures.js';
import { WAL_V1_ENUMS, type CborProtocolValue, type ProtocolTuple } from '../protocol/schema.js';
import { createWalObjectV1, verifyWalObjectV1 } from '../protocol/wal-object.js';
import { decodeDkgPayloadEnvelope, encodePublicDkgPayload } from '../privacy/crypto.js';
import { bytesEqualV1 } from '../rdf/keys.js';
import { canonicalizeNQuadsV1, requireCanonicalNQuadsV1 } from '../rdf/nquads.js';
import { MutableSetCommitment } from '../reconciliation/set-commitment.js';
import { migrationError, WalMigrationError } from './errors.js';
import {
  WAL_GENESIS_GRAPH_FAMILIES_V1,
  type NormalizedWalGenesisStateV1,
  type VerifiedLegacyGenesisV1,
  type WalGenesisAuthorLanePlanV1,
  type WalGenesisLocalSourceV1,
  type WalGenesisPayloadEncoderV1,
  type WalGenesisPlanV1,
  type WalGenesisSnapshotArtifactV1,
  type WalGenesisVectorArtifactV1,
  type WalGenesisVectorHeadV1,
  type WalLegacyGenesisArtifactV1,
  type WalLegacyGenesisLanePlanV1,
  type WalMigrationSemanticCoreV1,
} from './types.js';

export const LEGACY_GENESIS_MEDIA_TYPE_V1 =
  'application/vnd.origintrail.wal-legacy-genesis+cbor';
export const GENESIS_SNAPSHOT_MEDIA_TYPE_V1 =
  'application/vnd.origintrail.wal-snapshot-manifest+cbor';

const GENESIS_MANIFEST_DOMAIN = new TextEncoder().encode('dkg-wal-genesis-manifest-v1\0');
const SNAPSHOT_KIND = BigInt(WAL_V1_ENUMS.payloadKind.SNAPSHOT_MANIFEST);
const LEGACY_GENESIS_KIND = BigInt(WAL_V1_ENUMS.payloadKind.LEGACY_GENESIS);
const DETERMINISTIC_CBOR = BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR);
const LIVE = BigInt(WAL_V1_ENUMS.snapshotEntryState.LIVE);
const TOMBSTONE = BigInt(WAL_V1_ENUMS.snapshotEntryState.TOMBSTONE);
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

function copy(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function fixed(value: Uint8Array, length: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    migrationError('WAL_MIGRATION_INVALID', `${label} must be exactly ${length} bytes`);
  }
  return copy(value);
}

function u64(value: bigint, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_U64) {
    migrationError('WAL_MIGRATION_INVALID', `${label} must be an unsigned 64-bit integer`);
  }
  return value;
}

function safeTime(value: number | bigint, label: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      migrationError('WAL_MIGRATION_INVALID', `${label} must be a non-negative safe integer`);
    }
    return BigInt(value);
  }
  return u64(value, label);
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function sameChainFrontier(
  left: ProtocolTuple<'ChainFrontierV1'> | null,
  right: ProtocolTuple<'ChainFrontierV1'> | null,
): boolean {
  if (left === null || right === null) return left === right;
  return bytesEqualV1(
    encodeProtocolTuple('ChainFrontierV1', left),
    encodeProtocolTuple('ChainFrontierV1', right),
  );
}

function sortCanonical<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => compareCanonicalCbor(
    left as CborProtocolValue,
    right as CborProtocolValue,
  ));
}

type SourceRow = import('./types.js').WalGenesisSourceRowV1;

function normalizeSourceRow(
  row: SourceRow,
  family: SourceRow['family'],
  collectionId: Uint8Array,
): NormalizedWalGenesisStateV1 {
  if (!row || row.family !== family) {
    migrationError(
      'WAL_MIGRATION_INVALID',
      `family reader ${family} returned a row for another graph family`,
    );
  }
  const rowCollection = fixed(row.collectionId, 32, 'row.collectionId');
  if (!bytesEqualV1(rowCollection, collectionId)) {
    migrationError('WAL_MIGRATION_MIXED_CONTEXT', 'genesis row belongs to another collection');
  }
  const namespaceId = fixed(row.namespaceId, 32, 'row.namespaceId');
  const logicalKey = fixed(row.logicalKey, 32, 'row.logicalKey');
  const policyObjectId = fixed(row.policyObjectId, 32, 'row.policyObjectId');
  const adapterVersion = u64(row.adapterVersion, 'row.adapterVersion');
  if (adapterVersion > 0xffffn) {
    migrationError('WAL_MIGRATION_INVALID', 'row.adapterVersion exceeds protocol u16');
  }
  if (row.visibility !== 'public' && row.visibility !== 'private') {
    migrationError('WAL_MIGRATION_INVALID', 'row.visibility is unsupported');
  }
  let canonical;
  try {
    canonical = canonicalizeNQuadsV1(row.graphBytes);
  } catch (error) {
    migrationError('WAL_MIGRATION_INVALID', 'genesis row RDF cannot be canonicalized', error);
  }
  let stateDigest: Uint8Array;
  if (row.stateKind === 'LIVE') {
    stateDigest = canonical.stateDigest;
    if (row.stateDigest !== undefined && !bytesEqualV1(fixed(row.stateDigest, 32, 'row.stateDigest'), stateDigest)) {
      migrationError('WAL_MIGRATION_INVALID', 'live row state digest does not match canonical RDF');
    }
  } else if (row.stateKind === 'TOMBSTONE') {
    if (canonical.bytes.length !== 0 || row.stateDigest === undefined) {
      migrationError(
        'WAL_MIGRATION_INVALID',
        'tombstone row requires empty canonical RDF and an explicit deleted-state digest',
      );
    }
    if (row.provenance.kind === 'UNCLAIMABLE') {
      migrationError(
        'WAL_MIGRATION_PROVENANCE',
        'LegacyGenesisV1 cannot distinguish an unclaimable tombstone from empty live state',
      );
    }
    stateDigest = fixed(row.stateDigest, 32, 'row.stateDigest');
  } else {
    migrationError('WAL_MIGRATION_INVALID', 'row.stateKind is unsupported');
  }
  const conflictDigest = row.conflictDigest === undefined || row.conflictDigest === null
    ? null
    : fixed(row.conflictDigest, 32, 'row.conflictDigest');
  const provenance = row.provenance?.kind === 'AUTHOR'
    ? { kind: 'AUTHOR' as const, writerId: fixed(row.provenance.writerId, 20, 'row.writerId') }
    : row.provenance?.kind === 'UNCLAIMABLE'
      ? { kind: 'UNCLAIMABLE' as const }
      : migrationError('WAL_MIGRATION_PROVENANCE', 'row provenance is unsupported');
  return {
    family,
    collectionId: rowCollection,
    namespaceId,
    logicalKey,
    visibility: row.visibility,
    stateKind: row.stateKind,
    canonicalGraphBytes: canonical.bytes,
    stateDigest,
    conflictDigest,
    provenance,
    policyObjectId,
    adapterVersion,
    chainFrontier: row.chainFrontier,
  };
}

function assertSameAuthorContext(
  lane: NormalizedWalGenesisStateV1,
  row: NormalizedWalGenesisStateV1,
): void {
  if (
    lane.visibility !== row.visibility
    || !bytesEqualV1(lane.policyObjectId, row.policyObjectId)
    || lane.adapterVersion !== row.adapterVersion
    || !sameChainFrontier(lane.chainFrontier, row.chainFrontier)
  ) {
    migrationError(
      'WAL_MIGRATION_MIXED_CONTEXT',
      'one author genesis lane contains mixed visibility, policy, adapter, or VM frontier',
    );
  }
}

function authorPlans(rows: readonly NormalizedWalGenesisStateV1[]): WalGenesisAuthorLanePlanV1[] {
  const groups = new Map<string, NormalizedWalGenesisStateV1[]>();
  for (const row of rows) {
    if (row.provenance.kind !== 'AUTHOR') continue;
    const key = `${hex(row.namespaceId)}:${hex(row.provenance.writerId)}`;
    const group = groups.get(key) ?? [];
    if (group.some(value => bytesEqualV1(value.logicalKey, row.logicalKey))) {
      migrationError('WAL_MIGRATION_DUPLICATE_STATE', 'author genesis lane repeats a logical key');
    }
    if (group.length > 0) assertSameAuthorContext(group[0]!, row);
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const first = group[0]!;
    const writerId = (first.provenance as Extract<NormalizedWalGenesisStateV1['provenance'], { kind: 'AUTHOR' }>).writerId;
    const entries = sortCanonical(group.map(row => [
      row.logicalKey,
      row.stateKind === 'LIVE' ? LIVE : TOMBSTONE,
      [],
      row.stateDigest,
      row.canonicalGraphBytes,
    ] as ProtocolTuple<'SnapshotEntryV1'>));
    const conflicts = sortCanonical(group.flatMap(row => row.conflictDigest === null ? [] : [[
      row.logicalKey,
      [],
      [],
      row.conflictDigest,
    ] as ProtocolTuple<'SnapshotConflictV1'>]));
    return {
      namespaceId: copy(first.namespaceId),
      writerId: copy(writerId),
      visibility: first.visibility,
      policyObjectId: copy(first.policyObjectId),
      adapterVersion: first.adapterVersion,
      chainFrontier: first.chainFrontier,
      entries,
      conflicts,
    };
  }).sort((left, right) => compareCanonicalCbor(
    [left.namespaceId, left.writerId],
    [right.namespaceId, right.writerId],
  ));
}

function legacyPlans(
  rows: readonly NormalizedWalGenesisStateV1[],
  migrationPolicyObjectId: Uint8Array,
): WalLegacyGenesisLanePlanV1[] {
  const groups = new Map<string, NormalizedWalGenesisStateV1[]>();
  for (const row of rows) {
    if (row.provenance.kind !== 'UNCLAIMABLE') continue;
    const key = hex(row.namespaceId);
    const group = groups.get(key) ?? [];
    if (group.some(value => bytesEqualV1(value.logicalKey, row.logicalKey))) {
      migrationError('WAL_MIGRATION_DUPLICATE_STATE', 'legacy genesis lane repeats a logical key');
    }
    if (group.length > 0 && group[0]!.visibility !== row.visibility) {
      migrationError('WAL_MIGRATION_MIXED_CONTEXT', 'legacy genesis namespace mixes visibility');
    }
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const first = group[0]!;
    const merged = canonicalizeNQuadsV1(concat(...group.map(row => row.canonicalGraphBytes)));
    return {
      collectionId: copy(first.collectionId),
      namespaceId: copy(first.namespaceId),
      visibility: first.visibility,
      sourceStateDigest: merged.stateDigest,
      canonicalGraphBytes: merged.bytes,
      logicalKeys: group.map(row => copy(row.logicalKey)).sort(compareCanonicalCbor),
      migrationPolicyObjectId: copy(migrationPolicyObjectId),
    };
  }).sort((left, right) => compareCanonicalCbor(left.namespaceId, right.namespaceId));
}

function planManifest(
  collectionId: Uint8Array,
  barrierVectorId: Uint8Array,
  createdAtMs: bigint,
  authorLanes: readonly WalGenesisAuthorLanePlanV1[],
  legacyLanes: readonly WalLegacyGenesisLanePlanV1[],
): Uint8Array {
  const value: readonly CborProtocolValue[] = [
    1n,
    collectionId,
    barrierVectorId,
    createdAtMs,
    authorLanes.map(lane => [
      lane.namespaceId,
      lane.writerId,
      lane.visibility,
      lane.policyObjectId,
      lane.adapterVersion,
      lane.chainFrontier,
      lane.entries,
      lane.conflicts,
    ]),
    legacyLanes.map(lane => [
      lane.collectionId,
      lane.namespaceId,
      lane.visibility,
      lane.sourceStateDigest,
      lane.canonicalGraphBytes,
      lane.logicalKeys,
      lane.migrationPolicyObjectId,
    ]),
  ];
  return encodeCanonicalCbor(value);
}

export async function buildWalGenesisPlanV1(input: {
  readonly collectionId: Uint8Array;
  readonly barrierVectorId: Uint8Array;
  readonly migrationPolicyObjectId: Uint8Array;
  readonly createdAtMs: number | bigint;
  readonly source: WalGenesisLocalSourceV1;
}): Promise<WalGenesisPlanV1> {
  const collectionId = fixed(input.collectionId, 32, 'collectionId');
  const barrierVectorId = fixed(input.barrierVectorId, 32, 'barrierVectorId');
  const migrationPolicyObjectId = fixed(input.migrationPolicyObjectId, 32, 'migrationPolicyObjectId');
  const createdAtMs = safeTime(input.createdAtMs, 'createdAtMs');
  if (!input.source || typeof input.source.readFamily !== 'function') {
    migrationError('WAL_MIGRATION_INVALID', 'a fixed-family local genesis source is required');
  }
  const rows: NormalizedWalGenesisStateV1[] = [];
  for (const family of WAL_GENESIS_GRAPH_FAMILIES_V1) {
    const values = input.source.readFamily(family);
    if (!values || typeof values[Symbol.asyncIterator] !== 'function') {
      migrationError('WAL_MIGRATION_INVALID', `family reader ${family} is not async iterable`);
    }
    for await (const row of values) rows.push(normalizeSourceRow(row, family, collectionId));
  }
  rows.sort((left, right) => compareCanonicalCbor(
    [left.namespaceId, left.logicalKey, left.provenance.kind === 'AUTHOR' ? left.provenance.writerId : new Uint8Array()],
    [right.namespaceId, right.logicalKey, right.provenance.kind === 'AUTHOR' ? right.provenance.writerId : new Uint8Array()],
  ));
  const authors = authorPlans(rows);
  const legacy = legacyPlans(rows, migrationPolicyObjectId);
  const manifestBytes = planManifest(collectionId, barrierVectorId, createdAtMs, authors, legacy);
  return {
    collectionId,
    barrierVectorId,
    createdAtMs,
    rows,
    authorLanes: authors,
    legacyLanes: legacy,
    manifestBytes,
    manifestDigest: blake3(concat(GENESIS_MANIFEST_DOMAIN, manifestBytes)),
  };
}

async function payloadBytes(input: {
  readonly visibility: 'public' | 'private';
  readonly namespaceId: Uint8Array;
  readonly writerId: Uint8Array;
  readonly writerEpoch: bigint;
  readonly payloadKind: bigint;
  readonly mediaType: string;
  readonly plaintext: Uint8Array;
  readonly encodePayload?: WalGenesisPayloadEncoderV1;
}): Promise<Uint8Array> {
  const bytes = input.encodePayload === undefined
    ? input.visibility === 'private'
      ? migrationError(
          'WAL_MIGRATION_PRIVATE_ENCODING',
          'private genesis state requires the existing authenticated encryption adapter',
        )
      : encodePublicDkgPayload({
          payloadKind: input.payloadKind,
          codec: DETERMINISTIC_CBOR,
          mediaType: input.mediaType,
          contentBytes: input.plaintext,
        }).canonicalBytes
    : await input.encodePayload({
        visibility: input.visibility,
        namespaceId: input.namespaceId,
        writerId: input.writerId,
        writerEpoch: input.writerEpoch,
        sequence: 0n,
        payloadKind: input.payloadKind,
        mediaType: input.mediaType,
        plaintext: input.plaintext,
      });
  let envelope: ProtocolTuple<'DkgPayloadEnvelopeV1'>;
  try {
    envelope = decodeDkgPayloadEnvelope(bytes);
  } catch (error) {
    migrationError('WAL_MIGRATION_PRIVATE_ENCODING', 'genesis payload encoder returned an invalid envelope', error);
  }
  if (
    envelope[1] !== input.payloadKind
    || envelope[2] !== DETERMINISTIC_CBOR
    || envelope[3] !== input.mediaType
    || (input.visibility === 'private') !== (envelope[4] !== null)
  ) {
    migrationError(
      'WAL_MIGRATION_PRIVATE_ENCODING',
      'genesis payload envelope visibility, kind, codec, or media type is mismatched',
    );
  }
  if (input.visibility === 'public' && !bytesEqualV1(envelope[5], input.plaintext)) {
    migrationError('WAL_MIGRATION_PRIVATE_ENCODING', 'public genesis envelope changed canonical plaintext');
  }
  return copy(bytes);
}

export async function createWalGenesisSnapshotArtifactV1(input: {
  readonly lane: WalGenesisAuthorLanePlanV1;
  readonly signer: WalEip191Signer;
  readonly encodePayload?: WalGenesisPayloadEncoderV1;
}): Promise<WalGenesisSnapshotArtifactV1> {
  const lane = input.lane;
  const empty = new MutableSetCommitment();
  const coveredCheckpoint = await signSingleProtocolTuple('AuthorCheckpointV1', [
    1n,
    fixed(lane.namespaceId, 32, 'lane.namespaceId'),
    fixed(lane.writerId, 20, 'lane.writerId'),
    0n,
    0n,
    1n,
    empty.root,
    0n,
    0n,
    null,
    null,
    0n,
  ], input.signer);
  const coveredCheckpointBytes = encodeProtocolTuple('AuthorCheckpointV1', coveredCheckpoint);
  const manifest: ProtocolTuple<'SnapshotManifestV1'> = [
    1n,
    lane.namespaceId,
    lane.writerId,
    1n,
    0n,
    protocolTupleId('AuthorCheckpointV1', coveredCheckpoint),
    empty.root,
    0n,
    0n,
    sortCanonical(lane.entries),
    sortCanonical(lane.conflicts),
    lane.policyObjectId,
    lane.adapterVersion,
    lane.chainFrontier,
  ];
  const plaintext = encodeProtocolTuple('SnapshotManifestV1', manifest);
  const encodedPayload = await payloadBytes({
    visibility: lane.visibility,
    namespaceId: lane.namespaceId,
    writerId: lane.writerId,
    writerEpoch: 1n,
    payloadKind: SNAPSHOT_KIND,
    mediaType: GENESIS_SNAPSHOT_MEDIA_TYPE_V1,
    plaintext,
    encodePayload: input.encodePayload,
  });
  const snapshotObject = await createWalObjectV1([
    1n,
    lane.namespaceId,
    lane.writerId,
    1n,
    0n,
    null,
    encodedPayload,
  ], input.signer);
  const headSet = new MutableSetCommitment([snapshotObject.walObjectId as never]);
  const headCheckpoint = await signSingleProtocolTuple('AuthorCheckpointV1', [
    1n,
    lane.namespaceId,
    lane.writerId,
    1n,
    0n,
    1n,
    headSet.root,
    1n,
    0n,
    null,
    snapshotObject.walObjectId,
    0n,
  ], input.signer);
  return {
    lane,
    coveredCheckpoint,
    coveredCheckpointBytes,
    manifest,
    snapshotObject,
    headCheckpoint,
    headCheckpointBytes: encodeProtocolTuple('AuthorCheckpointV1', headCheckpoint),
  };
}

export async function createWalLegacyGenesisArtifactV1(input: {
  readonly lane: WalLegacyGenesisLanePlanV1;
  readonly barrierVectorId: Uint8Array;
  readonly createdAtMs: number | bigint;
  readonly migrationWriterId: Uint8Array;
  readonly signer: WalEip191Signer;
  readonly encodePayload?: WalGenesisPayloadEncoderV1;
}): Promise<WalLegacyGenesisArtifactV1> {
  const lane = input.lane;
  const writerId = fixed(input.migrationWriterId, 20, 'migrationWriterId');
  const legacyGenesis: ProtocolTuple<'LegacyGenesisV1'> = [
    1n,
    fixed(lane.collectionId, 32, 'lane.collectionId'),
    fixed(lane.namespaceId, 32, 'lane.namespaceId'),
    fixed(lane.sourceStateDigest, 32, 'lane.sourceStateDigest'),
    copy(lane.canonicalGraphBytes),
    0n,
    fixed(lane.migrationPolicyObjectId, 32, 'lane.migrationPolicyObjectId'),
    fixed(input.barrierVectorId, 32, 'barrierVectorId'),
    safeTime(input.createdAtMs, 'createdAtMs'),
  ];
  const plaintext = encodeProtocolTuple('LegacyGenesisV1', legacyGenesis);
  const encodedPayload = await payloadBytes({
    visibility: lane.visibility,
    namespaceId: lane.namespaceId,
    writerId,
    writerEpoch: 0n,
    payloadKind: LEGACY_GENESIS_KIND,
    mediaType: LEGACY_GENESIS_MEDIA_TYPE_V1,
    plaintext,
    encodePayload: input.encodePayload,
  });
  const object = await createWalObjectV1([
    1n,
    lane.namespaceId,
    writerId,
    0n,
    0n,
    null,
    encodedPayload,
  ], input.signer);
  const set = new MutableSetCommitment([object.walObjectId as never]);
  const checkpoint = await signSingleProtocolTuple('AuthorCheckpointV1', [
    1n,
    lane.namespaceId,
    writerId,
    0n,
    0n,
    1n,
    set.root,
    1n,
    0n,
    null,
    null,
    0n,
  ], input.signer);
  return {
    lane,
    legacyGenesis,
    object,
    checkpoint,
    checkpointBytes: encodeProtocolTuple('AuthorCheckpointV1', checkpoint),
  };
}

export async function verifyLegacyGenesisV1(input: {
  readonly canonicalObjectBytes: Uint8Array;
  readonly expectedCollectionId: Uint8Array;
  readonly expectedNamespaceId: Uint8Array;
  readonly expectedMigrationPolicyObjectId: Uint8Array;
  readonly expectedBarrierVectorId: Uint8Array;
  readonly semanticCore: WalMigrationSemanticCoreV1;
  readonly decryptPrivate?: (
    object: ProtocolTuple<'WalObjectV1'>,
    envelope: ProtocolTuple<'DkgPayloadEnvelopeV1'>,
  ) => Uint8Array | Promise<Uint8Array>;
}): Promise<VerifiedLegacyGenesisV1> {
  let verified;
  let envelope: ProtocolTuple<'DkgPayloadEnvelopeV1'>;
  let legacy: ProtocolTuple<'LegacyGenesisV1'>;
  try {
    verified = verifyWalObjectV1(input.canonicalObjectBytes);
    envelope = decodeDkgPayloadEnvelope(verified.payloadBytes);
    if (
      envelope[1] !== LEGACY_GENESIS_KIND
      || envelope[2] !== DETERMINISTIC_CBOR
      || envelope[3] !== LEGACY_GENESIS_MEDIA_TYPE_V1
    ) throw new Error('wrong legacy genesis envelope metadata');
    const plaintext = envelope[4] === null
      ? envelope[5]
      : input.decryptPrivate === undefined
        ? migrationError(
            'WAL_MIGRATION_PRIVATE_ENCODING',
            'private LegacyGenesisV1 requires authenticated decryption by the existing crypto adapter',
          )
        : await input.decryptPrivate(verified.tuple, envelope);
    legacy = decodeProtocolTuple('LegacyGenesisV1', plaintext);
  } catch (error) {
    if (error instanceof WalMigrationError) throw error;
    migrationError('WAL_MIGRATION_LEGACY_BINDING', 'LegacyGenesisV1 object is invalid', error);
  }
  const canonical = requireCanonicalNQuadsV1(legacy[4]);
  if (
    verified.tuple[4] !== 0n
    || verified.tuple[5] !== null
    || !bytesEqualV1(verified.tuple[1], legacy[2])
    || !bytesEqualV1(legacy[1], fixed(input.expectedCollectionId, 32, 'expectedCollectionId'))
    || !bytesEqualV1(legacy[2], fixed(input.expectedNamespaceId, 32, 'expectedNamespaceId'))
    || !bytesEqualV1(legacy[3], canonical.stateDigest)
    || !bytesEqualV1(legacy[6], fixed(input.expectedMigrationPolicyObjectId, 32, 'expectedMigrationPolicyObjectId'))
    || !bytesEqualV1(legacy[7], fixed(input.expectedBarrierVectorId, 32, 'expectedBarrierVectorId'))
  ) {
    migrationError(
      'WAL_MIGRATION_LEGACY_BINDING',
      'LegacyGenesisV1 object does not bind its coordinates, state, policy, or pre-genesis barrier vector',
    );
  }
  const decision = await input.semanticCore.authorizeLegacyGenesis({
    object: verified.tuple,
    legacyGenesis: legacy,
    migrationPolicyObjectId: legacy[6],
    barrierVectorId: legacy[7],
  });
  if (decision.status === 'rejected') {
    migrationError(
      'WAL_MIGRATION_UNAUTHORIZED',
      `existing DKG semantic core rejected LegacyGenesisV1: ${decision.reasonCode}`,
    );
  }
  return {
    objectId: copy(verified.walObjectId),
    object: verified.tuple,
    legacyGenesis: legacy,
    decision,
  };
}

export async function createWalGenesisVectorV1(input: {
  readonly plan: WalGenesisPlanV1;
  readonly membershipCheckpointId: Uint8Array;
  readonly activeNamespaceIds: readonly Uint8Array[];
  readonly heads: readonly WalGenesisVectorHeadV1[];
  readonly vectorEpoch: bigint;
  readonly vectorNumber: bigint;
  readonly issuedAtMs: number | bigint;
  readonly expiresAtMs: number | bigint;
  readonly finalizedChainFrontier: ProtocolTuple<'ChainFrontierV1'> | null;
  readonly authoritySetId: Uint8Array;
  readonly signers: readonly WalEip191Signer[];
}): Promise<WalGenesisVectorArtifactV1> {
  const active = input.activeNamespaceIds.map((value, index) => fixed(value, 32, `activeNamespaceIds[${index}]`));
  active.sort(compareCanonicalCbor);
  for (let index = 1; index < active.length; index += 1) {
    if (bytesEqualV1(active[index - 1]!, active[index]!)) {
      migrationError('WAL_MIGRATION_DUPLICATE_STATE', 'active namespace list contains a duplicate');
    }
  }
  const byNamespace = new Map(active.map(value => [hex(value), [] as ProtocolTuple<'WriterCheckpointV1'>[]]));
  for (const head of input.heads) {
    const namespaceId = fixed(head.namespaceId, 32, 'head.namespaceId');
    const group = byNamespace.get(hex(namespaceId));
    if (group === undefined) {
      migrationError('WAL_MIGRATION_MIXED_CONTEXT', 'genesis vector head names an inactive namespace');
    }
    const writerId = fixed(head.writerId, 20, 'head.writerId');
    if (group.some(value => bytesEqualV1(value[0], writerId))) {
      migrationError('WAL_MIGRATION_DUPLICATE_STATE', 'genesis vector repeats a namespace writer');
    }
    group.push([writerId, fixed(head.checkpointId, 32, 'head.checkpointId')]);
  }
  const expectedNamespaces = sortCanonical(active.map(namespaceId => [
    namespaceId,
    [...byNamespace.get(hex(namespaceId))!].sort(compareCanonicalCbor),
  ] as ProtocolTuple<'ExpectedNamespaceV1'>));
  const issuedAtMs = safeTime(input.issuedAtMs, 'issuedAtMs');
  const expiresAtMs = safeTime(input.expiresAtMs, 'expiresAtMs');
  if (expiresAtMs <= issuedAtMs) {
    migrationError('WAL_MIGRATION_INVALID', 'genesis vector validity interval is empty');
  }
  const vector = await signThresholdProtocolTuple('CollectionHeadVectorV1', [
    1n,
    fixed(input.plan.collectionId, 32, 'plan.collectionId'),
    fixed(input.membershipCheckpointId, 32, 'membershipCheckpointId'),
    expectedNamespaces,
    u64(input.vectorEpoch, 'vectorEpoch'),
    u64(input.vectorNumber, 'vectorNumber'),
    fixed(input.plan.barrierVectorId, 32, 'plan.barrierVectorId'),
    issuedAtMs,
    expiresAtMs,
    input.finalizedChainFrontier,
    fixed(input.authoritySetId, 32, 'authoritySetId'),
  ], input.signers);
  return {
    vector,
    vectorId: protocolTupleId('CollectionHeadVectorV1', vector),
    canonicalBytes: encodeProtocolTuple('CollectionHeadVectorV1', vector),
  };
}
