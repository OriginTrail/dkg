import type { ProtocolTuple } from '../protocol/schema.js';
import type { WalEip191Signer } from '../protocol/signatures.js';
import type { VerifiedWalObjectV1 } from '../protocol/wal-object.js';

/**
 * The complete local graph-family allowlist for protocol-v1 genesis capture.
 * There is intentionally no arbitrary/list-all graph family.
 */
export const WAL_GENESIS_GRAPH_FAMILIES_V1 = Object.freeze([
  'SWM_CONTENT',
  'SWM_METADATA',
  'VM_CONTENT',
  'VM_METADATA',
] as const);

export type WalGenesisGraphFamilyV1 = typeof WAL_GENESIS_GRAPH_FAMILIES_V1[number];
export type WalGenesisVisibilityV1 = 'public' | 'private';
export type WalGenesisStateKindV1 = 'LIVE' | 'TOMBSTONE';

export type WalGenesisProvenanceV1 =
  | {
      readonly kind: 'AUTHOR';
      readonly writerId: Uint8Array;
    }
  | {
      readonly kind: 'UNCLAIMABLE';
    };

/** One accepted logical state emitted by a local, family-specific reader. */
export interface WalGenesisSourceRowV1 {
  readonly family: WalGenesisGraphFamilyV1;
  readonly collectionId: Uint8Array;
  readonly namespaceId: Uint8Array;
  readonly logicalKey: Uint8Array;
  readonly visibility: WalGenesisVisibilityV1;
  readonly stateKind: WalGenesisStateKindV1;
  readonly graphBytes: string | Uint8Array;
  /** Required for tombstones; optional equality assertion for live state. */
  readonly stateDigest?: Uint8Array;
  readonly conflictDigest?: Uint8Array | null;
  readonly provenance: WalGenesisProvenanceV1;
  readonly policyObjectId: Uint8Array;
  readonly adapterVersion: bigint;
  readonly chainFrontier: ProtocolTuple<'ChainFrontierV1'> | null;
}

export interface WalGenesisLocalSourceV1 {
  /** Reads one fixed local family. It must not enumerate remote graphs. */
  readFamily(
    family: WalGenesisGraphFamilyV1,
  ): AsyncIterable<WalGenesisSourceRowV1>;
}

export interface NormalizedWalGenesisStateV1 {
  readonly family: WalGenesisGraphFamilyV1;
  readonly collectionId: Uint8Array;
  readonly namespaceId: Uint8Array;
  readonly logicalKey: Uint8Array;
  readonly visibility: WalGenesisVisibilityV1;
  readonly stateKind: WalGenesisStateKindV1;
  readonly canonicalGraphBytes: Uint8Array;
  readonly stateDigest: Uint8Array;
  readonly conflictDigest: Uint8Array | null;
  readonly provenance: WalGenesisProvenanceV1;
  readonly policyObjectId: Uint8Array;
  readonly adapterVersion: bigint;
  readonly chainFrontier: ProtocolTuple<'ChainFrontierV1'> | null;
}

export interface WalGenesisAuthorLanePlanV1 {
  readonly namespaceId: Uint8Array;
  readonly writerId: Uint8Array;
  readonly visibility: WalGenesisVisibilityV1;
  readonly policyObjectId: Uint8Array;
  readonly adapterVersion: bigint;
  readonly chainFrontier: ProtocolTuple<'ChainFrontierV1'> | null;
  readonly entries: readonly ProtocolTuple<'SnapshotEntryV1'>[];
  readonly conflicts: readonly ProtocolTuple<'SnapshotConflictV1'>[];
}

export interface WalLegacyGenesisLanePlanV1 {
  readonly collectionId: Uint8Array;
  readonly namespaceId: Uint8Array;
  readonly visibility: WalGenesisVisibilityV1;
  readonly sourceStateDigest: Uint8Array;
  readonly canonicalGraphBytes: Uint8Array;
  readonly logicalKeys: readonly Uint8Array[];
  readonly migrationPolicyObjectId: Uint8Array;
}

export interface WalGenesisPlanV1 {
  readonly collectionId: Uint8Array;
  /** Signed pre-genesis maintenance vector; never the final self-containing vector. */
  readonly barrierVectorId: Uint8Array;
  readonly createdAtMs: bigint;
  readonly rows: readonly NormalizedWalGenesisStateV1[];
  readonly authorLanes: readonly WalGenesisAuthorLanePlanV1[];
  readonly legacyLanes: readonly WalLegacyGenesisLanePlanV1[];
  readonly manifestBytes: Uint8Array;
  readonly manifestDigest: Uint8Array;
}

export type WalGenesisPayloadEncoderV1 = (input: {
  readonly visibility: WalGenesisVisibilityV1;
  readonly namespaceId: Uint8Array;
  readonly writerId: Uint8Array;
  readonly writerEpoch: bigint;
  readonly sequence: bigint;
  readonly payloadKind: bigint;
  readonly mediaType: string;
  readonly plaintext: Uint8Array;
}) => Uint8Array | Promise<Uint8Array>;

export interface WalGenesisSnapshotArtifactV1 {
  readonly lane: WalGenesisAuthorLanePlanV1;
  readonly coveredCheckpoint: ProtocolTuple<'AuthorCheckpointV1'>;
  readonly coveredCheckpointBytes: Uint8Array;
  readonly manifest: ProtocolTuple<'SnapshotManifestV1'>;
  readonly snapshotObject: VerifiedWalObjectV1;
  readonly headCheckpoint: ProtocolTuple<'AuthorCheckpointV1'>;
  readonly headCheckpointBytes: Uint8Array;
}

export interface WalLegacyGenesisArtifactV1 {
  readonly lane: WalLegacyGenesisLanePlanV1;
  readonly legacyGenesis: ProtocolTuple<'LegacyGenesisV1'>;
  readonly object: VerifiedWalObjectV1;
  readonly checkpoint: ProtocolTuple<'AuthorCheckpointV1'>;
  readonly checkpointBytes: Uint8Array;
}

export interface WalGenesisVectorHeadV1 {
  readonly namespaceId: Uint8Array;
  readonly writerId: Uint8Array;
  readonly checkpointId: Uint8Array;
}

export interface WalGenesisVectorArtifactV1 {
  readonly vector: ProtocolTuple<'CollectionHeadVectorV1'>;
  readonly vectorId: Uint8Array;
  readonly canonicalBytes: Uint8Array;
}

export interface WalGenesisSignerResolverV1 {
  resolveAuthorSigner(writerId: Uint8Array): WalEip191Signer | Promise<WalEip191Signer>;
}

export type WalLegacyGenesisDecisionV1 =
  | { readonly status: 'quarantined'; readonly reasonCode: string }
  | { readonly status: 'visible'; readonly reasonCode: string }
  | { readonly status: 'rejected'; readonly reasonCode: string };

export interface WalMigrationSemanticCoreV1 {
  authorizeLegacyGenesis(input: {
    readonly object: ProtocolTuple<'WalObjectV1'>;
    readonly legacyGenesis: ProtocolTuple<'LegacyGenesisV1'>;
    readonly migrationPolicyObjectId: Uint8Array;
    readonly barrierVectorId: Uint8Array;
  }): Promise<WalLegacyGenesisDecisionV1>;
}

export interface VerifiedLegacyGenesisV1 {
  readonly objectId: Uint8Array;
  readonly object: ProtocolTuple<'WalObjectV1'>;
  readonly legacyGenesis: ProtocolTuple<'LegacyGenesisV1'>;
  readonly decision: Exclude<WalLegacyGenesisDecisionV1, { readonly status: 'rejected' }>;
}

export type WalBackfillPathV1 =
  | 'INCREMENTAL'
  | 'SNAPSHOT_PLUS_DELTA'
  | 'GENESIS_BOOTSTRAP'
  | 'PROJECTION_REBUILD';

export interface WalBackfillTargetLaneV1 {
  readonly namespaceId: Uint8Array;
  readonly writerId: Uint8Array;
  readonly writerEpoch: bigint;
  readonly checkpointId: Uint8Array;
  readonly objectSetRoot: Uint8Array;
  readonly objectCount: bigint;
  readonly compactionFloor: bigint;
  readonly baselineSnapshotObjectId: Uint8Array | null;
  readonly genesisBaseline: boolean;
}

export interface WalBackfillLocalLaneV1 {
  readonly present: boolean;
  readonly writerEpoch: bigint | null;
  readonly objectCount: bigint;
  readonly checkpointId: Uint8Array | null;
  readonly completeWal: boolean;
  readonly projection: 'complete' | 'missing' | 'corrupt';
}

export interface WalBackfillPlanLaneV1 {
  readonly laneKey: string;
  readonly path: WalBackfillPathV1;
  readonly target: WalBackfillTargetLaneV1;
}

export interface WalBackfillPlanV1 {
  readonly sessionId: string;
  readonly targetVectorId: Uint8Array;
  readonly lanes: readonly WalBackfillPlanLaneV1[];
}

export interface WalBackfillCompleteObjectV1 {
  readonly objectId: Uint8Array;
  readonly canonicalBytes: Uint8Array;
}

export type WalBackfillStageV1 = 'BASELINE' | 'DELTA' | 'REPLAY' | 'VERIFY';

export interface WalBackfillJournalV1 {
  completedStages(sessionId: string, laneKey: string): Promise<ReadonlySet<WalBackfillStageV1>>;
  markCompleted(sessionId: string, laneKey: string, stage: WalBackfillStageV1): Promise<void>;
}

export interface WalBackfillTargetParityV1 {
  readonly objectRoot: boolean;
  readonly completeObjects: boolean;
  readonly rdf: boolean;
  readonly conflicts: boolean;
  readonly tombstones: boolean;
  readonly vm: boolean;
}

export interface WalBackfillOperationsV1 {
  /** Network byte paths. Neither callback may enumerate remote RDF graphs. */
  fetchBaseline(target: WalBackfillTargetLaneV1): Promise<readonly WalBackfillCompleteObjectV1[]>;
  fetchDelta(target: WalBackfillTargetLaneV1): Promise<readonly WalBackfillCompleteObjectV1[]>;
  /** Local complete bytes only; used for projection-only rebuild. */
  loadLocalObjects(target: WalBackfillTargetLaneV1): Promise<readonly WalBackfillCompleteObjectV1[]>;
  /** The one verifier/admission pipeline, with ingress supplied only as context. */
  verifyAndAdmit(
    object: WalBackfillCompleteObjectV1,
    ingress: 'backfill' | 'replay',
  ): Promise<void>;
  /** The WAL-014 adapter and WAL-015 materializer over the shared semantic core. */
  replayAndMaterialize(target: WalBackfillTargetLaneV1): Promise<void>;
  verifyTarget(target: WalBackfillTargetLaneV1): Promise<WalBackfillTargetParityV1>;
}

export interface WalBackfillRunResultV1 {
  readonly sessionId: string;
  readonly networkPayloadBytes: bigint;
  readonly admittedObjects: number;
  readonly completedLanes: number;
}

export type WalGenesisBarrierArtifactKindV1 =
  | 'PLAN_MANIFEST'
  | 'COVERED_CHECKPOINT'
  | 'SNAPSHOT_OBJECT'
  | 'HEAD_CHECKPOINT'
  | 'LEGACY_OBJECT'
  | 'LEGACY_CHECKPOINT'
  | 'HEAD_VECTOR';

/** A durable output of the barrier. WAL objects remain the only synchronization atoms. */
export interface WalGenesisBarrierArtifactV1 {
  readonly key: string;
  readonly kind: WalGenesisBarrierArtifactKindV1;
  readonly id: Uint8Array;
  readonly canonicalBytes: Uint8Array;
}

export interface WalGenesisBarrierBundleV1 {
  readonly barrierId: Uint8Array;
  readonly collectionId: Uint8Array;
  readonly barrierVectorId: Uint8Array;
  readonly planManifestDigest: Uint8Array;
  readonly headVectorId: Uint8Array;
  readonly artifacts: readonly WalGenesisBarrierArtifactV1[];
}

export interface WalGenesisDryRunReportV1 {
  readonly collectionId: Uint8Array;
  readonly barrierVectorId: Uint8Array;
  readonly manifestDigest: Uint8Array;
  readonly rowCount: number;
  readonly authorLaneCount: number;
  readonly legacyLaneCount: number;
  readonly liveCount: number;
  readonly tombstoneCount: number;
  readonly canonicalBytes: Uint8Array;
  readonly reportDigest: Uint8Array;
}

export interface WalGenesisBarrierJournalStateV1 {
  readonly barrierId: Uint8Array;
  readonly bundleDigest: Uint8Array;
  readonly writesPaused: boolean;
  readonly persistedArtifactKeys: readonly string[];
  readonly shadowCursor: string | null;
  readonly writesResumed: boolean;
  readonly completed: boolean;
  readonly aborted: boolean;
}

export interface WalGenesisBarrierJournalV1 {
  load(barrierId: Uint8Array): Promise<WalGenesisBarrierJournalStateV1 | null>;
  save(state: WalGenesisBarrierJournalStateV1): Promise<void>;
}

export interface WalPostBarrierMutationProofV1 {
  readonly mutationId: string;
  readonly walObjectId: Uint8Array | null;
  readonly durable: boolean;
}

export interface WalGenesisBarrierOperationsV1 {
  /** Must report the synchronization authority; this coordinator never changes it. */
  currentSyncAuthority(): Promise<'legacy' | 'wal'>;
  /** All mutation paths must be fenced. Calls are required to be idempotent. */
  pauseWrites(input: { readonly barrierId: Uint8Array; readonly collectionId: Uint8Array }): Promise<void>;
  /** Persist bytes idempotently. HEAD_VECTOR is deliberately delivered last. */
  persistArtifact(artifact: WalGenesisBarrierArtifactV1): Promise<void>;
  /** Arm durable shadow capture and return its stable production-mutation cursor. */
  armShadowCapture(input: {
    readonly barrierId: Uint8Array;
    readonly collectionId: Uint8Array;
    readonly headVectorId: Uint8Array;
  }): Promise<string>;
  /** May resume only after shadow capture is durable. Calls are required to be idempotent. */
  resumeWrites(input: { readonly barrierId: Uint8Array; readonly shadowCursor: string }): Promise<void>;
  /** Enumerate local production mutation receipts after the durable cursor, never remote graphs. */
  auditPostBarrierShadow(input: {
    readonly barrierId: Uint8Array;
    readonly shadowCursor: string;
  }): Promise<readonly WalPostBarrierMutationProofV1[]>;
  /** Abort a still-paused barrier while leaving legacy synchronization authoritative. */
  abortPausedBarrier(input: { readonly barrierId: Uint8Array; readonly collectionId: Uint8Array }): Promise<void>;
}

export interface WalGenesisBarrierRunResultV1 {
  readonly barrierId: Uint8Array;
  readonly headVectorId: Uint8Array;
  readonly shadowCursor: string;
  readonly persistedArtifacts: number;
  readonly auditedMutations: number;
}

export interface WalBackfillEvidenceManifestV1 {
  readonly canonicalBytes: Uint8Array;
  readonly digest: Uint8Array;
  readonly baselineP95Micros: bigint;
  readonly backfillP95Micros: bigint;
  readonly meetsP95: boolean;
}
