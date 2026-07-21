import type {
  AdmissionJournalEntry,
  KnowledgeAssetVmPublishRequest,
  LiftJob,
  LiftJobBroadcast,
  LiftJobFinalizationMetadata,
  LiftJobIncluded,
  LiftJobInclusionMetadata,
  LiftJobHex,
  LiftJobState,
  LiftJobValidationMetadata,
  LiftPublishRequestMetadata,
  LiftPublishSnapshotRequest,
} from './lift-job.js';
import type { DKGPublisher } from './dkg-publisher.js';
import type { PublishOptions, PublishResult } from './publisher.js';
import type { AsyncLiftPublishFailureInput } from './async-lift-publish-result.js';
import type { AsyncPreparedPublishPayload, LiftResolvedPublishSlice } from './async-lift-publish-options.js';
import type { WorkspacePublicSnapshotStore } from './workspace-snapshot-store.js';

export class AsyncLiftJobConflictError extends Error {
  readonly code = 'ASYNC_LIFT_JOB_CONFLICT';

  constructor(
    message: string,
    readonly existingJobId: string,
  ) {
    super(message);
    this.name = 'AsyncLiftJobConflictError';
  }
}

/** #1828 — the immutable facts a client retains to recover a lost VM-publish admission. */
export interface IntentLookupInput {
  readonly contextGraphId: string;
  readonly name: string;
  readonly subGraphName?: string;
  readonly agentAddress?: string;
  /** Optional exactness qualifier; sets `exactIntentMatch` on the result. */
  readonly intentKey?: string;
}

/**
 * #1828 — deterministic result of an intent lookup. At most one ACTIVE job can
 * exist per lifecycle subject (admission dedup invariant), so `active` is the
 * live job to bind; `superseded` carries terminal jobs sharing the subject;
 * `conflict` (>1 active) signals a broken invariant. `exactIntentMatch` (only
 * when the caller passed `intentKey`) reports whether the returned job's stored
 * intent equals it.
 */
export type IntentLookupResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'active'; readonly job: LiftJob; readonly superseded: LiftJob[]; readonly exactIntentMatch?: boolean }
  | { readonly kind: 'superseded'; readonly jobs: LiftJob[]; readonly exactIntentMatch?: boolean }
  | { readonly kind: 'conflict'; readonly jobs: LiftJob[] };

export interface AsyncLiftPublisher {
  enqueueKnowledgeAssetVmPublish(request: KnowledgeAssetVmPublishRequest): Promise<string>;
  claimNext(walletId: string): Promise<LiftJob | null>;
  update(jobId: string, status: LiftJobState, data?: Partial<LiftJob>): Promise<void>;
  getStatus(jobId: string): Promise<LiftJob | null>;
  list(filter?: { status?: LiftJobState }): Promise<LiftJob[]>;
  inspectPreparedPayload(jobId: string): Promise<AsyncPreparedPublishPayload | null>;
  processNext(walletId: string): Promise<LiftJob | null>;
  recordPublishResult(jobId: string, publishResult: PublishResult, options?: { publicByteSize?: number }): Promise<LiftJob>;
  recordPublishFailure(jobId: string, failure: AsyncLiftPublishFailureInput): Promise<LiftJob>;
  recover(): Promise<number>;
  getStats(): Promise<Record<LiftJobState, number>>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(jobId: string): Promise<void>;
  retry(filter?: { status?: 'failed' }): Promise<number>;
  clear(status: 'finalized' | 'failed'): Promise<number>;
}

/**
 * #1828 — a publisher that also exposes the read-only durable-admission intent
 * recovery lookup. Kept OFF the base {@link AsyncLiftPublisher} runtime queue
 * contract so runner/adapter implementations that never serve recovery are not
 * forced to implement it (the exported contract stays minimal). The daemon's
 * `createPublisherControlFromStore` returns this; the recovery route depends on
 * it. PR3/PR4 add their own feature reads on their own extended interfaces —
 * the base contract does not grow.
 */
export interface VmPublishIntentRecoveryPublisher extends AsyncLiftPublisher {
  /** #1828 — read-only recovery lookup by lifecycle facts (+ optional intentKey). */
  lookupKnowledgeAssetVmPublishJobByIntent(facts: IntentLookupInput): Promise<IntentLookupResult>;
}

/** #1829 — read query for the append-only journal (facts-pure, or by jobId). */
export interface JournalReadInput {
  readonly contextGraphId: string;
  readonly name: string;
  readonly subGraphName?: string;
  readonly agentAddress?: string;
  /** Optional per-version filter WITHIN the lineage; never the lineage key itself. */
  readonly intentKey?: string;
}

/**
 * #1829 — result of a journal read. `entries` are seq-ordered; `maxSeq` is -1 for an
 * empty lineage. `complete` = `entries.length === maxSeq + 1` (no seq gap) — authoritative
 * on oxigraph-worker; best-effort on external SPARQL backends (no fsync, so the
 * highest-seq entry can be lost on a crash without a gap being visible). `txHashes` are
 * ATTEMPTED submissions — a reconciler MUST verify each against chain; a hash here is
 * never proof the tx was sent (a pre-flush 'broadcast' entry can survive a rolled-back
 * attempt).
 */
export interface JournalReadResult {
  readonly entries: readonly AdmissionJournalEntry[];
  readonly maxSeq: number;
  readonly complete: boolean;
  readonly txHashes: readonly string[];
}

/**
 * #1829 — read-only append-only journal reader. Segregated off the base contract (like
 * the #1828 recovery lookup): only the daemon control instance serves it.
 */
export interface VmPublishAdmissionJournalReader {
  /** Facts-pure lineage read (derives lineageKey from facts, never the ephemeral index). */
  readJournalByIntent(facts: JournalReadInput): Promise<JournalReadResult>;
  /** All journal entries bearing this jobId (a successor job continues the lineage seq). */
  readJournalByJob(jobId: string): Promise<JournalReadResult>;
}

/**
 * #1828 — one-shot storage maintenance: (re)build the ephemeral intent index for
 * VM-publish jobs admitted before it existed. This is a boot-time repair, not a
 * runtime publisher behaviour, so it lives on its OWN narrow interface — the
 * daemon boot backfill depends only on this, never on the publisher contract.
 */
export interface VmPublishIntentIndexBackfiller {
  /** Idempotent additive backfill; returns the number of jobs (re)indexed. */
  ensureVmPublishIntentIndex(): Promise<number>;
}

export interface AsyncLiftPublisherRecoveryResult {
  inclusion: LiftJobInclusionMetadata;
  finalization: LiftJobFinalizationMetadata;
}

/** Required immutable transaction evidence for named-KA lifecycle recovery. */
export interface AsyncKnowledgeAssetVmPublishRecoveryEvidence
  extends AsyncLiftPublisherRecoveryResult {
  readonly publishProof: {
    readonly merkleRoot: LiftJobHex;
    readonly authorAddress: LiftJobHex;
  };
}

export interface AsyncLiftPublishExecutionInput {
  readonly walletId: string;
  readonly publishOptions: PublishOptions;
}

export interface AsyncKnowledgeAssetVmPublishExecutionInput {
  readonly walletId: string;
  readonly request: KnowledgeAssetVmPublishRequest;
  readonly snapshot: LiftPublishSnapshotRequest;
  readonly snapshotMetadata: LiftPublishRequestMetadata;
  readonly validation: LiftJobValidationMetadata;
  readonly resolved: LiftResolvedPublishSlice;
  readonly publishOptions: PublishOptions;
  readonly publisher?: DKGPublisher;
}

export interface AsyncKnowledgeAssetVmPublishPreflightInput {
  readonly walletId: string;
  readonly request: KnowledgeAssetVmPublishRequest;
  readonly snapshot: LiftPublishSnapshotRequest;
  readonly snapshotMetadata: LiftPublishRequestMetadata;
  readonly publisher?: DKGPublisher;
}

/**
 * Chain-confirmed recovery input for a named Knowledge Asset publish that was
 * interrupted after the transaction hash had been durably recorded.
 *
 * The finalizer is intentionally separate from the normal executor: recovery
 * must reconcile local VM/lifecycle state without submitting a second
 * transaction.
 */
export interface AsyncKnowledgeAssetVmPublishRecoveryInput {
  readonly walletId: string;
  readonly request: KnowledgeAssetVmPublishRequest;
  readonly job: LiftJobBroadcast | LiftJobIncluded;
  readonly recovery: AsyncKnowledgeAssetVmPublishRecoveryEvidence;
  readonly publisher?: DKGPublisher;
}

export type AsyncKnowledgeAssetVmPublishPreflightResult =
  | { readonly action: 'execute' }
  | { readonly action: 'noop'; readonly reason?: string };

/** Cohesive lifecycle boundary for one named-KA async queue job. */
export interface AsyncKnowledgeAssetVmPublishJobHandler {
  execute(input: AsyncKnowledgeAssetVmPublishExecutionInput): Promise<PublishResult>;
  preflight?(
    input: AsyncKnowledgeAssetVmPublishPreflightInput,
  ): Promise<AsyncKnowledgeAssetVmPublishPreflightResult>;
  finalizeRecovered?(input: AsyncKnowledgeAssetVmPublishRecoveryInput): Promise<void>;
}

export type AsyncLiftPublisherRecoveryResolver = (
  job: LiftJobBroadcast | LiftJobIncluded,
) => Promise<AsyncLiftPublisherRecoveryResult | null>;

export type AsyncKnowledgeAssetVmPublishRecoveryResolver = (
  job: LiftJobBroadcast | LiftJobIncluded,
) => Promise<AsyncKnowledgeAssetVmPublishRecoveryEvidence | null>;

export interface AsyncLiftPublisherConfig {
  graphUri?: string;
  maxRetries?: number;
  retryBackoffBaseMs?: number;
  retryBackoffMaxMs?: number;
  recoveryLookupTimeoutMs?: number;
  now?: () => number;
  idGenerator?: () => string;
  chainRecoveryResolver?: AsyncLiftPublisherRecoveryResolver;
  knowledgeAssetVmPublishRecoveryResolver?: AsyncKnowledgeAssetVmPublishRecoveryResolver;
  publishExecutor?: (input: AsyncLiftPublishExecutionInput) => Promise<PublishResult>;
  knowledgeAssetVmPublishHandler?: AsyncKnowledgeAssetVmPublishJobHandler;
  /** @deprecated Use knowledgeAssetVmPublishHandler.execute. */
  knowledgeAssetVmPublishExecutor?: (
    input: AsyncKnowledgeAssetVmPublishExecutionInput,
  ) => Promise<PublishResult>;
  /** @deprecated Use knowledgeAssetVmPublishHandler.preflight. */
  knowledgeAssetVmPublishPreflight?: (
    input: AsyncKnowledgeAssetVmPublishPreflightInput,
  ) => Promise<AsyncKnowledgeAssetVmPublishPreflightResult>;
  /** @deprecated Use knowledgeAssetVmPublishHandler.finalizeRecovered. */
  knowledgeAssetVmPublishRecoveryFinalizer?: (
    input: AsyncKnowledgeAssetVmPublishRecoveryInput,
  ) => Promise<void>;
  resolvedSliceOverrides?: Partial<LiftResolvedPublishSlice>;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  /**
   * #1829 — enable append-only admission/transaction journal writes. DAEMON-ONLY:
   * left OFF for the CLI inspector and standalone `dkg publisher run` so a second
   * OS process on the same store never races the node-local per-lineageKey seq
   * allocation. Reads never require this flag. Defaults to OFF.
   */
  journalWrites?: boolean;
}
