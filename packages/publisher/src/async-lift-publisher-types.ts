import type {
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
  RawLiftRequest,
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

export interface AsyncLiftPublisher {
  lift(request: RawLiftRequest): Promise<string>;
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

export interface AsyncLiftPublisherRecoveryResult {
  inclusion: LiftJobInclusionMetadata;
  finalization: LiftJobFinalizationMetadata;
  /** Immutable evidence emitted by the exact transaction being recovered. */
  publishProof?: {
    readonly merkleRoot: LiftJobHex;
    readonly authorAddress?: LiftJobHex;
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
  readonly recovery: AsyncLiftPublisherRecoveryResult;
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

export interface AsyncLiftPublisherConfig {
  graphUri?: string;
  maxRetries?: number;
  retryBackoffBaseMs?: number;
  retryBackoffMaxMs?: number;
  recoveryLookupTimeoutMs?: number;
  now?: () => number;
  idGenerator?: () => string;
  chainRecoveryResolver?: AsyncLiftPublisherRecoveryResolver;
  publishExecutor?: (input: AsyncLiftPublishExecutionInput) => Promise<PublishResult>;
  knowledgeAssetVmPublishHandler?: AsyncKnowledgeAssetVmPublishJobHandler;
  resolvedSliceOverrides?: Partial<LiftResolvedPublishSlice>;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
}
