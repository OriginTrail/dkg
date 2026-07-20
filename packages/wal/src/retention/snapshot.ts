import { decodeProtocolTuple, encodeProtocolTuple } from '../protocol/codec.js';
import { protocolTupleId } from '../protocol/hashes.js';
import { verifySingleSignedProtocolTuple } from '../protocol/signatures.js';
import { WAL_V1_ENUMS, type ProtocolTuple } from '../protocol/schema.js';
import { verifyWalObjectV1, type WalObjectV1 } from '../protocol/wal-object.js';
import { MutableSetCommitment } from '../reconciliation/set-commitment.js';
import { walObjectId } from '../reconciliation/ids.js';
import { decodeDkgPayloadEnvelope } from '../privacy/crypto.js';
import { bytesEqualV1 } from '../rdf/keys.js';
import { requireCanonicalNQuadsV1 } from '../rdf/nquads.js';
import { retentionError } from './errors.js';
import {
  SNAPSHOT_MANIFEST_MEDIA_TYPE_V1,
  type BaselineSelectionV1,
  type VerifiedSnapshotBaselineV1,
  type WalRetentionSemanticCoreV1,
} from './types.js';

const SNAPSHOT_KIND = BigInt(WAL_V1_ENUMS.payloadKind.SNAPSHOT_MANIFEST);
const DETERMINISTIC_CBOR = BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR);
const LIVE = BigInt(WAL_V1_ENUMS.snapshotEntryState.LIVE);
const TOMBSTONE = BigInt(WAL_V1_ENUMS.snapshotEntryState.TOMBSTONE);

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function sameCanonical<Name extends 'ChainFrontierV1'>(
  name: Name,
  left: ProtocolTuple<Name> | null,
  right: ProtocolTuple<Name> | null,
): boolean {
  if (left === null || right === null) return left === right;
  return bytesEqualV1(encodeProtocolTuple(name, left), encodeProtocolTuple(name, right));
}

function uniqueKeyedTuples(
  values: readonly (readonly [Uint8Array, ...unknown[]])[],
  label: string,
): void {
  const keys = new Set<string>();
  for (const value of values) {
    const key = hex(value[0]);
    if (keys.has(key)) retentionError('WAL_RETENTION_SNAPSHOT_STATE', `${label} repeats logicalKey ${key}`);
    keys.add(key);
  }
}

export interface VerifySnapshotBaselineInputV1 {
  readonly snapshotObjectCanonicalBytes: Uint8Array;
  readonly coveredCheckpointCanonicalBytes: Uint8Array;
  readonly coveredObjectIds: readonly Uint8Array[];
  readonly expectedPolicyObjectId: Uint8Array;
  readonly expectedAdapterVersion: bigint;
  readonly expectedChainFrontier: ProtocolTuple<'ChainFrontierV1'> | null;
  readonly semanticCore: WalRetentionSemanticCoreV1;
  /** Genesis has an authenticated empty covered lane and no fabricated pre-WAL heads. */
  readonly baselineKind?: 'retention' | 'genesis';
  /**
   * Required only for a private envelope. The current crypto implementation
   * must authenticate/decrypt it; this callback cannot return untrusted bytes.
   */
  readonly decryptPrivateManifest?: (
    object: WalObjectV1,
    envelope: ProtocolTuple<'DkgPayloadEnvelopeV1'>,
  ) => Uint8Array | Promise<Uint8Array>;
  /** Current retained set or another already-authenticated author baseline. */
  readonly externalHeadReachable: (objectId: Uint8Array) => boolean | Promise<boolean>;
}

/** Verify the complete author snapshot and its old-epoch closure. */
export async function verifySnapshotBaselineV1(
  input: VerifySnapshotBaselineInputV1,
): Promise<VerifiedSnapshotBaselineV1> {
  if (input.baselineKind !== undefined && input.baselineKind !== 'retention' && input.baselineKind !== 'genesis') {
    retentionError('WAL_RETENTION_INVALID', 'snapshot baseline kind is unsupported');
  }
  const genesis = input.baselineKind === 'genesis';
  const object = verifyWalObjectV1(input.snapshotObjectCanonicalBytes);
  const envelope = decodeDkgPayloadEnvelope(object.payloadBytes);
  if (
    envelope[1] !== SNAPSHOT_KIND
    || envelope[2] !== DETERMINISTIC_CBOR
    || envelope[3] !== SNAPSHOT_MANIFEST_MEDIA_TYPE_V1
  ) {
    retentionError(
      'WAL_RETENTION_SNAPSHOT_BINDING',
      'snapshot payload envelope kind, codec, or media type is not SnapshotManifestV1',
    );
  }
  const content = envelope[4] === null
    ? envelope[5]
    : input.decryptPrivateManifest === undefined
      ? retentionError(
          'WAL_RETENTION_SNAPSHOT_BINDING',
          'private snapshot requires authenticated decryption by the current crypto implementation',
        )
      : await input.decryptPrivateManifest(object.tuple, envelope);
  let manifest: ProtocolTuple<'SnapshotManifestV1'>;
  let checkpoint: ProtocolTuple<'AuthorCheckpointV1'>;
  try {
    manifest = decodeProtocolTuple('SnapshotManifestV1', content);
    checkpoint = decodeProtocolTuple('AuthorCheckpointV1', input.coveredCheckpointCanonicalBytes);
    verifySingleSignedProtocolTuple('AuthorCheckpointV1', checkpoint);
  } catch (error) {
    retentionError('WAL_RETENTION_SNAPSHOT_BINDING', 'snapshot or covered checkpoint is invalid', error);
  }
  const checkpointId = protocolTupleId('AuthorCheckpointV1', checkpoint);
  if (
    object.tuple[4] !== 0n
    || object.tuple[5] !== null
    || !bytesEqualV1(object.tuple[1], manifest[1])
    || !bytesEqualV1(object.tuple[2], manifest[2])
    || object.tuple[3] !== manifest[3]
    || manifest[3] !== manifest[4] + 1n
  ) {
    retentionError(
      'WAL_RETENTION_SNAPSHOT_BINDING',
      'snapshot must be sequence zero of the exact next author epoch with no predecessor',
    );
  }
  if (
    !bytesEqualV1(checkpointId, manifest[5])
    || !bytesEqualV1(checkpoint[1], manifest[1])
    || !bytesEqualV1(checkpoint[2], manifest[2])
    || checkpoint[3] !== manifest[4]
    || !bytesEqualV1(checkpoint[6], manifest[6])
    || checkpoint[7] !== manifest[7]
    || manifest[8] !== manifest[7]
  ) {
    retentionError(
      'WAL_RETENTION_SNAPSHOT_BINDING',
      'manifest does not exactly bind its signed covered checkpoint, root, count, and v1 floor',
    );
  }
  if (genesis && (
    manifest[4] !== 0n
    || manifest[7] !== 0n
    || manifest[8] !== 0n
    || checkpoint[4] !== 0n
    || checkpoint[7] !== 0n
    || checkpoint[8] !== 0n
    || checkpoint[9] !== null
    || checkpoint[10] !== null
    || checkpoint[11] !== 0n
  )) {
    retentionError(
      'WAL_RETENTION_SNAPSHOT_BINDING',
      'genesis snapshot must bind the signed empty epoch-zero checkpoint without pre-WAL history',
    );
  }
  if (
    !bytesEqualV1(manifest[11], input.expectedPolicyObjectId)
    || manifest[12] !== input.expectedAdapterVersion
    || !sameCanonical('ChainFrontierV1', manifest[13], input.expectedChainFrontier)
  ) {
    retentionError(
      'WAL_RETENTION_SNAPSHOT_BINDING',
      'snapshot policy, RDF adapter, or VM frontier is stale or mismatched',
    );
  }
  const ids = input.coveredObjectIds.map(value => walObjectId(value));
  let commitment: MutableSetCommitment;
  try {
    commitment = new MutableSetCommitment(ids);
  } catch (error) {
    retentionError('WAL_RETENTION_SNAPSHOT_CLOSURE', 'covered object set is not canonical', error);
  }
  if (
    BigInt(commitment.size) !== manifest[7]
    || !bytesEqualV1(commitment.root, manifest[6])
  ) {
    retentionError(
      'WAL_RETENTION_SNAPSHOT_CLOSURE',
      'covered object IDs do not reproduce the signed checkpoint set commitment',
    );
  }
  const covered = new Set(ids.map(hex));
  uniqueKeyedTuples(manifest[9], 'snapshot entries');
  uniqueKeyedTuples(manifest[10], 'snapshot conflicts');
  const entryKeys = new Set(manifest[9].map(entry => hex(entry[0])));
  for (const entry of manifest[9]) {
    if (
      (genesis && entry[2].length !== 0)
      || (!genesis && entry[2].length === 0)
      || entry[2].some(head => !covered.has(hex(head)))
    ) {
      retentionError(
        'WAL_RETENTION_SNAPSHOT_CLOSURE',
        genesis
          ? 'genesis snapshot entries must not fabricate pre-WAL active heads'
          : 'every author snapshot entry requires covered same-author active heads',
      );
    }
    if (entry[1] === LIVE) {
      let canonical;
      try {
        canonical = requireCanonicalNQuadsV1(entry[4]);
      } catch (error) {
        retentionError('WAL_RETENTION_SNAPSHOT_STATE', 'live snapshot state is not canonical N-Quads', error);
      }
      if (!bytesEqualV1(canonical.stateDigest, entry[3])) {
        retentionError('WAL_RETENTION_SNAPSHOT_STATE', 'live snapshot state digest does not match inline bytes');
      }
    } else if (entry[1] === TOMBSTONE) {
      if (entry[4].length !== 0) {
        retentionError('WAL_RETENTION_SNAPSHOT_STATE', 'tombstone snapshot entry must contain empty graph bytes');
      }
    /* v8 ignore start -- canonical SnapshotEntryV1 decoding restricts stateKind to LIVE or TOMBSTONE. */
    } else {
      retentionError('WAL_RETENTION_SNAPSHOT_STATE', 'snapshot entry state kind is unsupported');
    }
    /* v8 ignore stop */
    if (!await input.semanticCore.validateSnapshotEntry({
      namespaceId: manifest[1],
      writerId: manifest[2],
      coveredWriterEpoch: manifest[4],
      entry,
      policyObjectId: manifest[11],
      adapterVersion: manifest[12],
      chainFrontier: manifest[13],
    })) {
      retentionError(
        'WAL_RETENTION_UNAUTHORIZED',
        'existing DKG semantic core rejected a snapshot baseline entry',
      );
    }
  }
  for (const conflict of manifest[10]) {
    if (
      !entryKeys.has(hex(conflict[0]))
      || (genesis && (conflict[1].length !== 0 || conflict[2].length !== 0))
      || (!genesis && conflict[1].length === 0)
    ) {
      retentionError(
        'WAL_RETENTION_SNAPSHOT_CLOSURE',
        genesis
          ? 'genesis snapshot conflict must touch an entry without fabricating pre-WAL heads'
          : 'snapshot conflict must touch an included entry and name external heads',
      );
    }
    for (const reference of [...conflict[1], ...conflict[2]]) {
      if (!covered.has(hex(reference)) && !await input.externalHeadReachable(reference)) {
        retentionError(
          'WAL_RETENTION_SNAPSHOT_CLOSURE',
          'snapshot conflict references an unreachable external author head',
        );
      }
    }
    if (!await input.semanticCore.validateSnapshotConflict({
      namespaceId: manifest[1],
      writerId: manifest[2],
      coveredWriterEpoch: manifest[4],
      conflict,
      policyObjectId: manifest[11],
      adapterVersion: manifest[12],
      chainFrontier: manifest[13],
    })) {
      retentionError(
        'WAL_RETENTION_UNAUTHORIZED',
        'existing DKG semantic core rejected a snapshot conflict baseline',
      );
    }
  }
  return {
    snapshotObjectId: object.walObjectId,
    snapshotObject: object.tuple,
    manifest,
    coveredCheckpointId: checkpointId,
    coveredCheckpoint: checkpoint,
    coveredObjectIds: ids,
  };
}

/** Decide whether reconciliation must install the authenticated baseline first. */
export function selectBaselineForPeerV1(input: {
  readonly manifest: ProtocolTuple<'SnapshotManifestV1'>;
  readonly snapshotObjectId: Uint8Array;
  readonly retainedWriterEpoch: bigint | null;
  readonly retainedCoveredEpochObjectCount: bigint;
}): BaselineSelectionV1 {
  const below = input.retainedWriterEpoch === null
    || input.retainedWriterEpoch < input.manifest[4]
    || (
      input.retainedWriterEpoch === input.manifest[4]
      && input.retainedCoveredEpochObjectCount < input.manifest[8]
    );
  return below
    ? { action: 'install-baseline', snapshotObjectId: new Uint8Array(input.snapshotObjectId) }
    : { action: 'reconcile-delta' };
}
