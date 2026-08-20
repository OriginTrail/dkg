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
  /** Resolved assertion AUTHOR (may differ from the caller — GH#1778 curator publish). */
  readonly agentAddress?: string;
  /**
   * Enqueuing CALLER identity (token holder / operator), distinct from the
   * resolved author (GH#1778). Used to stamp the CG curator on `CG_NOT_REGISTERED`
   * auto-registration, matching the synchronous `vm/publish` lane — the async
   * worker registers under the caller who requested the publish, not the KA
   * author and not the node's default. Absent → registration falls back to the
   * node default inside `stampAddressCurator`, exactly as the sync lane does.
   */
  readonly callerAgentAddress?: string;
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
  /** Immutable access policy captured with the queued SWM snapshot. */
  readonly accessPolicy?: LiftAccessPolicy;
  /** Canonical peer allow-list when accessPolicy is allowList. */
  readonly allowedPeers?: readonly string[];
  /** V10 selective-disclosure mode captured at enqueue. */
  readonly entityProofs?: boolean;
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

/**
 * Persisted V10 root-lift request. Kept only so existing queue records can be
 * inspected and recovered; runtime enqueue is disabled by default.
 *
 * @deprecated Legacy root-scoped Knowledge Assets are read-only.
 */
export interface RawLiftRequest extends LiftRequestBase {
  readonly jobType?: 'lift';
}

/** @deprecated Use KnowledgeAssetVmPublishRequest for all new queue writes. */
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
  /**
   * ONE budget shared by every reaccept of this job — automatic (registry `autoRetry` codes,
   * scheduled with jittered backoff) and manual (`retry()`, admission re-submit) alike. Snapshot
   * from the publisher's `maxRetries` at admission and immutable thereafter, so raising the
   * daemon setting does not re-arm jobs already queued. Once `retryCount` reaches it the job is
   * terminal for the automatic lane: nothing further is scheduled and the sweep skips it.
   */
  readonly maxRetries: number;
  readonly lastRetryReason?: string;
}

// GH#2270 — the DERIVED retry read model (`LiftJobRetryProjection`, `LiftJobRetryWaitingReason`)
// lives in async-lift-retry-disposition.ts, beside the classifier that produces it. This file is
// the PERSISTED job shape; nothing derived on read belongs in it.

export interface LiftJobRecoveryResetToAccepted {
  readonly action: 'reset_to_accepted';
  readonly recoveredFromStatus: LiftJobResettableState;
  readonly txHashChecked?: LiftJobHex;
  /**
   * GH#2270 PR-3 r3 — the chain ACCOUNTED for `txHashChecked`, and this reset is what it decided.
   *
   * The hash is kept for audit either way, but it stops being an open question. Without this a
   * proven-absent release is self-defeating: the reset carries the hash forward so a LATER failure
   * is still held, which is right while the transaction's fate is unknown — and wrong the moment
   * recovery has just proven it. The job would go back on the queue, fail again before ever
   * signing anything, and be held on a transaction the dispatcher itself established does not
   * exist, with no second proof possible because nothing new was ever sent.
   *
   * Written ONLY by the proof-first dispatcher's release paths: a proven absence, and a proven
   * revert of a transaction some earlier attempt sent. Never by the interrupted-recovery reset,
   * the retry sweep, or a manual reaccept — none of those has asked the chain anything, and a hash
   * they carry forward is still genuinely unaccounted for.
   *
   * A NEW post-sign failure records fresh `broadcast` metadata, which is unconditional evidence:
   * this flag only ever speaks about the INHERITED hash it sits beside.
   */
  readonly txHashAccounted?: boolean;
  /**
   * GH#2270 PR #2300 r3 — the branch the checked transaction signed, carried across resets exactly
   * like `txHashChecked` is: a reset rebuilds the job and drops `broadcast`, so without this a job
   * that signed a CREATE would fall back to the pre-marker default (update, i.e. held) the moment
   * recovery released it for a re-run.
   */
  readonly operationKind?: 'create' | 'update';
  /**
   * GH#2270 PR #2300 r21 (🔴 3812632539) — the WALLET that signed `txHashChecked`, carried
   * across the reset for the same reason the hash and the operation marker are. A reset drops
   * `broadcast`, and the job can then be claimed by a DIFFERENT wallet; pairing the inherited hash
   * with that later claim builds a lookup for a transaction/account combination that never
   * existed, and update recognition binds the publisher to the wrong wallet — stranding a job
   * whose transaction actually mined. Absent (a pre-r21 record), the inherited hash has no
   * authoritative signer and the job stays held rather than being asked about under a guess.
   */
  readonly walletIdChecked?: string;
  /** The nonce that transaction consumed, preserved with its signer for the absence proof. */
  readonly nonceChecked?: number;
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
  /**
   * GH#2270 PR-3 — the account nonce the signed transaction reserved, written in the same pre-send
   * write-ahead as `txHash`.
   *
   * This is what lets recovery PROVE absence. A null transaction lookup is point-in-time and
   * backend-local: a broadcast whose response timed out can still be accepted and mined later, so
   * "the node does not have it" is never on its own proof that nothing published. Once this slot
   * is spent at a FINALIZED block and the transaction is still missing, it can never mine — that
   * is proof, and it is the only thing that releases a held job by absence.
   *
   * Optional because it is only as available as the signing path makes it: records written before
   * this field existed, and any signed transaction whose nonce could not be parsed, carry none.
   * Recovery reads a missing nonce as no proof and keeps holding.
   */
  readonly nonce?: number;
  /**
   * GH#2270 PR #2300 r3 — the branch this transaction actually signed, recorded at the write-ahead
   * because it cannot be recovered from the request afterwards (a queued publish can resolve its
   * update branch from the LIVE lifecycle pointer, not only from `vmCurrentAssertion`). Recovery's
   * absence-release is create-only, so this is what makes that decision honest for any job this
   * build writes; a record without it predates the marker and is treated as an update, i.e. held.
   */
  readonly operationKind?: 'create' | 'update';
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

// #1829 — append-only admission & transaction journal (named-KA lift-publish only).
// The `kind` a writeJob call site stamps onto the transition it persists. Passed to
// writeJob(job, kind) at all 21 sites so the compiler rejects a wrong literal.
// `rollback-noop` is a SENTINEL: the #1851 recordDurableBroadcastBeforeSend rollback
// re-writes the prior 'validated' job through writeJob, and that re-write must NOT
// append a spurious entry — appendJournal no-ops on this kind. It therefore never
// appears in a persisted AdmissionJournalEntry.
export type JournalKind =
  | 'admission'
  | 'reaccept'
  | 'recover-reset'
  | 'claimed'
  | 'validated'
  | 'broadcast'
  | 'included'
  | 'finalized'
  | 'noop-finalized'
  | 'recovered-finalize'
  | 'failed'
  | 'rollback-noop';

/** A persisted journal kind (every JournalKind except the no-op sentinel). */
export type PersistedJournalKind = Exclude<JournalKind, 'rollback-noop'>;

/**
 * #1829 — one immutable, append-only journal entry. Node-local; seq is a per-lineageKey
 * monotonic xsd:integer. `lineageKey` is the facts-derivable lifecycle tuple
 * (knowledgeAssetVmPublishLifecycleKey), NOT intentKey. `intentKey` (when present) is a
 * per-version disambiguator for filtering WITHIN a lineage, never the lineage key.
 * txHashes recorded here are ATTEMPTED — reconcile against chain, never treat as sent.
 * Bounded metadata + hashes only (no payloads).
 */
export interface AdmissionJournalEntry {
  readonly seq: number;
  readonly at: number;
  readonly kind: PersistedJournalKind;
  readonly jobId: string;
  readonly lineageKey: string;
  readonly intentKey?: string;
  readonly txHash?: string;
  readonly blockNumber?: number;
  readonly merkleRoot?: string;
  readonly ual?: string;
  readonly failureCode?: string;
  readonly recoveredFromStatus?: string;
  readonly supersedesJobId?: string;
  readonly successorJobId?: string;
}
