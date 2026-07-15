import type {
  LiftAuthorityType,
  LiftJobChainRecoverableState,
  LiftJobResettableState,
  LiftJobState,
  LiftTransitionType,
} from './lift-job-states.js';
import type { LiftJobFailureMetadata } from './lift-job-failures.js';

export type LiftJobHex = `0x${string}`;

export type LiftJobBigInt = `${bigint}`;

export interface LiftAuthorityProof {
  readonly type: LiftAuthorityType;
  readonly proofRef: string;
}

export type LiftAccessPolicy = 'public' | 'ownerOnly' | 'allowList';

/** EIP-712 AuthorAttestation seal computed at enqueue. Hex-encoded for JSON persistence. */
export interface LiftRequestAuthorSeal {
  readonly merkleRoot: LiftJobHex;
  readonly authorAddress: LiftJobHex;
  readonly signature: { readonly r: LiftJobHex; readonly vs: LiftJobHex };
  readonly schemeVersion: number;
  /**
   * OT-RFC-43 §F2 — the packed reservedKaId `(uint160(author) << 96) | number`
   * the author signed into the AuthorAttestation digest at enqueue. The on-chain
   * mint MUST `_safeMint` exactly this id (the publisher threads it through
   * `precomputedAttestation.reservedKaId` → `ensureReservedKaId`, which reuses it
   * verbatim rather than re-allocating). Stringified bigint so it survives the
   * lift queue's JSON persistence and the full 256-bit packed value (never a JS
   * `number`). Optional for backward-compat with seals persisted before §F2
   * async binding landed; a missing value is read back as `0n` (the legacy
   * sealless/0n behaviour — the on-chain mint then rejects it, which is exactly
   * why those seals were never minted).
   */
  readonly reservedKaId?: LiftJobBigInt;
}

export interface KnowledgeAssetVmPublishRequest {
  readonly contextGraphId: string;
  readonly name: string;
  readonly agentAddress?: string;
  readonly subGraphName?: string;
  readonly shareOperationId: string;
  readonly roots: readonly string[];
  /** Graph-scoped v2 discriminator. Missing/one is a legacy read-only job. */
  readonly contentScopeVersion?: number;
  /** Canonical UAL for the one atomic queued Knowledge Asset. */
  readonly kaUal?: string;
  /** One-based assertion version included in the immutable graph identity. */
  readonly assertionVersion?: string;
  /** Exact public triple count committed by the queued seal. */
  readonly publicTripleCount?: number;
  /** Optional single KA-level private commitment. */
  readonly privateMerkleRoot?: LiftJobHex;
  /** Exact private triple count committed by privateMerkleRoot. */
  readonly privateTripleCount?: number;
  /** Author seal captured with the queued SWM share snapshot. */
  readonly seal: LiftRequestAuthorSeal;
  readonly sealChainId: LiftJobBigInt;
  readonly sealKav10Address: LiftJobHex;
  readonly sealFinalizedAtIso: string;
  readonly sealMerkleRoot: LiftJobHex;
  readonly intentKey: string;
  readonly wmCurrentAssertion?: string;
  readonly swmCurrentAssertion?: string;
  readonly vmCurrentAssertion?: string;
  readonly kaNumber?: string;
  readonly reservedUal?: string;
  readonly publishEpochs?: number;
  readonly clearSharedMemoryAfter?: boolean;
  readonly publisherNodeIdentityIdOverride?: LiftJobBigInt;
}

export interface LiftPublishSnapshotRequest {
  readonly shareOperationId: string;
  readonly roots: readonly string[];
  readonly contextGraphId: string;
  /** Graph-scoped v2 discriminator. Missing/one is a legacy read-only snapshot. */
  readonly contentScopeVersion?: number;
  readonly kaUal?: string;
  readonly assertionVersion?: string;
  readonly publicTripleCount?: number;
  readonly privateMerkleRoot?: LiftJobHex;
  readonly privateTripleCount?: number;
  readonly priorVersion?: string;
  readonly subGraphName?: string;
  readonly accessPolicy?: LiftAccessPolicy;
  readonly allowedPeers?: readonly string[];
  /** V10 selective-disclosure mode; agent must sign over the same flag value. */
  readonly entityProofs?: boolean;
  /** Optional on-chain publish lifetime override in epochs. */
  readonly publishEpochs?: number;
  /** RFC-001 §4 attribution; stringified bigint, `'0'` = mode d (no attribution). */
  readonly publisherNodeIdentityIdOverride?: LiftJobBigInt;
  /** Agent-signed seal. Publisher rejects on-chain publish if absent on V10. */
  readonly seal?: LiftRequestAuthorSeal;
}

export interface LiftPublishRequestMetadata {
  readonly scope: string;
  readonly transitionType: LiftTransitionType;
  readonly authority: LiftAuthorityProof;
}

export interface LiftRequestBase extends LiftPublishSnapshotRequest, LiftPublishRequestMetadata {
  readonly swmId: string;
  readonly namespace: string;
}

export interface RawLiftRequest extends LiftRequestBase {
  readonly jobType?: 'lift';
}

export type LiftRequest = RawLiftRequest;

export interface RawLiftJobRequest {
  readonly jobType: 'lift';
  readonly lift: RawLiftRequest;
}

export interface KnowledgeAssetVmPublishJobRequest {
  readonly jobType: 'knowledge-asset-vm-publish';
  readonly knowledgeAssetVmPublish: KnowledgeAssetVmPublishRequest;
}

export type LiftJobRequest = RawLiftJobRequest | KnowledgeAssetVmPublishJobRequest;

export const LIFT_REQUEST_IMMUTABLE_FIELDS = [
  'jobType',
  'lift',
  'knowledgeAssetVmPublish',
] as const;

export interface LiftJobTimestamps {
  readonly acceptedAt: number;
  readonly claimedAt?: number;
  readonly validatedAt?: number;
  readonly broadcastAt?: number;
  readonly includedAt?: number;
  readonly finalizedAt?: number;
  readonly failedAt?: number;
  readonly lastRetriedAt?: number;
  readonly nextRetryAt?: number;
  readonly lastRecoveredAt?: number;
  readonly updatedAt: number;
}

export interface LiftJobRetryMetadata {
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly lastRetryReason?: string;
}

export interface LiftJobRecoveryResetToAccepted {
  readonly action: 'reset_to_accepted';
  readonly recoveredFromStatus: LiftJobResettableState;
  readonly txHashChecked?: LiftJobHex;
  readonly note?: string;
}

export interface LiftJobRecoveryFinalizedFromChain {
  readonly action: 'finalized_from_chain';
  readonly recoveredFromStatus: LiftJobChainRecoverableState;
  readonly txHashChecked: LiftJobHex;
  readonly note?: string;
}

export type LiftJobRecoveryMetadata = LiftJobRecoveryResetToAccepted | LiftJobRecoveryFinalizedFromChain;

export interface LiftJobRecoveryResetClaimed extends LiftJobRecoveryResetToAccepted {
  readonly recoveredFromStatus: 'claimed';
}

export interface LiftJobRecoveryResetValidated extends LiftJobRecoveryResetToAccepted {
  readonly recoveredFromStatus: 'validated';
}

export interface LiftJobRecoveryResetBroadcast extends LiftJobRecoveryResetToAccepted {
  readonly recoveredFromStatus: 'broadcast';
}

export interface LiftJobRecoveryFinalizedBroadcast extends LiftJobRecoveryFinalizedFromChain {
  readonly recoveredFromStatus: 'broadcast';
}

export interface LiftJobRecoveryFinalizedIncluded extends LiftJobRecoveryFinalizedFromChain {
  readonly recoveredFromStatus: 'included';
}

export interface LiftJobClaimMetadata {
  readonly walletId: string;
  readonly claimedBy?: string;
  readonly claimToken?: string;
  readonly claimLeaseExpiresAt?: number;
}

export interface LiftJobValidationMetadata {
  readonly canonicalRoots: readonly string[];
  readonly canonicalRootMap: Readonly<Record<string, string>>;
  readonly swmQuadCount: number;
  readonly authorityProofRef: string;
  readonly transitionType: LiftTransitionType;
  readonly priorVersion?: string;
}

export interface LiftJobBroadcastMetadata {
  readonly txHash: LiftJobHex;
  readonly walletId: string;
  readonly merkleRoot?: LiftJobHex;
  readonly publicByteSize?: number;
}

export interface LiftJobInclusionMetadata {
  readonly txHash: LiftJobHex;
  readonly blockNumber: number;
  readonly blockHash?: LiftJobHex;
  readonly blockTimestamp?: number;
}

export interface LiftJobFinalizationMetadata {
  readonly mode?: 'published' | 'noop' | 'local';
  readonly txHash?: LiftJobHex;
  readonly ual?: string;
  readonly batchId?: LiftJobBigInt;
  readonly startKAId?: LiftJobBigInt;
  readonly endKAId?: LiftJobBigInt;
  readonly publisherAddress?: LiftJobHex;
}

export interface LiftJobControlPlaneRefs {
  readonly jobRef?: string;
  readonly walletLockRef?: string;
}

export const LIFT_JOB_IMMUTABLE_FIELDS = [
  'jobId',
  'jobSlug',
  'request',
  'timestamps.acceptedAt',
  'retries.maxRetries',
] as const;

export const LIFT_JOB_PROGRESS_METADATA_FIELDS = [
  'claim',
  'validation',
  'broadcast',
  'inclusion',
  'finalization',
  'failure',
  'recovery',
] as const;

export const LIFT_JOB_MUTABLE_PERSISTED_FIELDS = [
  'status',
  'timestamps',
  'retries',
  'claim',
  'validation',
  'broadcast',
  'inclusion',
  'finalization',
  'failure',
  'recovery',
  'controlPlane',
] as const;

export interface LiftJobBase {
  readonly jobId: string;
  readonly jobSlug: string;
  readonly request: LiftJobRequest;
  readonly status: LiftJobState;
  readonly timestamps: LiftJobTimestamps;
  readonly retries: LiftJobRetryMetadata;
  readonly recovery?: LiftJobRecoveryMetadata;
  readonly controlPlane?: LiftJobControlPlaneRefs;
}

export interface LiftJobAccepted extends LiftJobBase {
  readonly status: 'accepted';
  readonly claim?: undefined;
  readonly validation?: undefined;
  readonly broadcast?: undefined;
  readonly inclusion?: undefined;
  readonly finalization?: undefined;
  readonly failure?: undefined;
}

export interface LiftJobClaimed extends LiftJobBase {
  readonly status: 'claimed';
  readonly claim: LiftJobClaimMetadata;
  readonly validation?: undefined;
  readonly broadcast?: undefined;
  readonly inclusion?: undefined;
  readonly finalization?: undefined;
  readonly failure?: undefined;
}

export interface LiftJobValidated extends LiftJobBase {
  readonly status: 'validated';
  readonly claim: LiftJobClaimMetadata;
  readonly validation: LiftJobValidationMetadata;
  readonly broadcast?: undefined;
  readonly inclusion?: undefined;
  readonly finalization?: undefined;
  readonly failure?: undefined;
}

export interface LiftJobBroadcast extends LiftJobBase {
  readonly status: 'broadcast';
  readonly claim: LiftJobClaimMetadata;
  readonly validation: LiftJobValidationMetadata;
  readonly broadcast: LiftJobBroadcastMetadata;
  readonly inclusion?: undefined;
  readonly finalization?: undefined;
  readonly failure?: undefined;
}

export interface LiftJobIncluded extends LiftJobBase {
  readonly status: 'included';
  readonly claim: LiftJobClaimMetadata;
  readonly validation: LiftJobValidationMetadata;
  readonly broadcast: LiftJobBroadcastMetadata;
  readonly inclusion: LiftJobInclusionMetadata;
  readonly finalization?: undefined;
  readonly failure?: undefined;
}

export interface LiftJobFinalizedPublished extends LiftJobBase {
  readonly status: 'finalized';
  readonly claim: LiftJobClaimMetadata;
  readonly validation: LiftJobValidationMetadata;
  readonly broadcast: LiftJobBroadcastMetadata;
  readonly inclusion: LiftJobInclusionMetadata;
  readonly finalization: LiftJobFinalizationMetadata & { readonly mode?: 'published' };
  readonly failure?: undefined;
}

export interface LiftJobFinalizedNoop extends LiftJobBase {
  readonly status: 'finalized';
  readonly claim: LiftJobClaimMetadata;
  readonly validation: LiftJobValidationMetadata;
  readonly broadcast?: undefined;
  readonly inclusion?: undefined;
  readonly finalization: LiftJobFinalizationMetadata & { readonly mode: 'noop' };
  readonly failure?: undefined;
}

export interface LiftJobFinalizedLocal extends LiftJobBase {
  readonly status: 'finalized';
  readonly claim: LiftJobClaimMetadata;
  readonly validation: LiftJobValidationMetadata;
  readonly broadcast?: undefined;
  readonly inclusion?: undefined;
  readonly finalization: LiftJobFinalizationMetadata & { readonly mode: 'local' };
  readonly failure?: undefined;
}

export type LiftJobFinalized = LiftJobFinalizedPublished | LiftJobFinalizedNoop | LiftJobFinalizedLocal;

export interface LiftJobFailed extends LiftJobBase {
  readonly status: 'failed';
  readonly finalization?: undefined;
}

export interface LiftJobFailedFromAccepted extends LiftJobFailed {
  readonly status: 'failed';
  readonly claim?: undefined;
  readonly validation?: undefined;
  readonly broadcast?: undefined;
  readonly inclusion?: undefined;
  readonly failure: LiftJobFailureMetadata & { readonly failedFromState: 'accepted' };
  readonly recovery?: undefined;
}

export interface LiftJobFailedFromClaimed extends LiftJobFailed {
  readonly status: 'failed';
  readonly claim: LiftJobClaimMetadata;
  readonly validation?: undefined;
  readonly broadcast?: undefined;
  readonly inclusion?: undefined;
  readonly failure: LiftJobFailureMetadata & { readonly failedFromState: 'claimed' };
  readonly recovery?: LiftJobRecoveryResetClaimed;
}

export interface LiftJobFailedFromValidated extends LiftJobFailed {
  readonly status: 'failed';
  readonly claim: LiftJobClaimMetadata;
  readonly validation: LiftJobValidationMetadata;
  readonly broadcast?: undefined;
  readonly inclusion?: undefined;
  readonly failure: LiftJobFailureMetadata & { readonly failedFromState: 'validated' };
  readonly recovery?: LiftJobRecoveryResetValidated;
}

export interface LiftJobFailedFromBroadcast extends LiftJobFailed {
  readonly status: 'failed';
  readonly claim: LiftJobClaimMetadata;
  readonly validation: LiftJobValidationMetadata;
  readonly broadcast: LiftJobBroadcastMetadata;
  readonly inclusion?: undefined;
  readonly failure: LiftJobFailureMetadata & { readonly failedFromState: 'broadcast' };
  readonly recovery?: LiftJobRecoveryResetBroadcast | LiftJobRecoveryFinalizedBroadcast;
}

export interface LiftJobFailedFromIncluded extends LiftJobFailed {
  readonly status: 'failed';
  readonly claim?: LiftJobClaimMetadata;
  readonly validation: LiftJobValidationMetadata;
  readonly broadcast: LiftJobBroadcastMetadata;
  readonly inclusion: LiftJobInclusionMetadata;
  readonly failure: LiftJobFailureMetadata & { readonly failedFromState: 'included' };
  readonly recovery?: LiftJobRecoveryFinalizedIncluded;
}

export type LiftJob =
  | LiftJobAccepted
  | LiftJobClaimed
  | LiftJobValidated
  | LiftJobBroadcast
  | LiftJobIncluded
  | LiftJobFinalized
  | LiftJobFailedFromAccepted
  | LiftJobFailedFromClaimed
  | LiftJobFailedFromValidated
  | LiftJobFailedFromBroadcast
  | LiftJobFailedFromIncluded;
