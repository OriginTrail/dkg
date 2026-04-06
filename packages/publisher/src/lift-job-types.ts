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

export interface LiftRequest {
  readonly swmId: string;
  readonly shareOperationId: string;
  readonly roots: readonly string[];
  readonly contextGraphId: string;
  readonly namespace: string;
  readonly scope: string;
  readonly transitionType: LiftTransitionType;
  readonly authority: LiftAuthorityProof;
  readonly priorVersion?: string;
}

export const LIFT_REQUEST_IMMUTABLE_FIELDS = [
  'swmId',
  'shareOperationId',
  'roots',
  'contextGraphId',
  'namespace',
  'scope',
  'transitionType',
  'authority',
  'priorVersion',
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
  readonly txHash: LiftJobHex;
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
  readonly request: LiftRequest;
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

export interface LiftJobFinalized extends LiftJobBase {
  readonly status: 'finalized';
  readonly claim: LiftJobClaimMetadata;
  readonly validation: LiftJobValidationMetadata;
  readonly broadcast: LiftJobBroadcastMetadata;
  readonly inclusion: LiftJobInclusionMetadata;
  readonly finalization: LiftJobFinalizationMetadata;
  readonly failure?: undefined;
}

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
