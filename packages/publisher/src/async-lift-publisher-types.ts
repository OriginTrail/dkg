import type { LiftJob, LiftJobBroadcast, LiftJobFinalizationMetadata, LiftJobIncluded, LiftJobInclusionMetadata, LiftJobState, LiftRequest } from './lift-job.js';
import type { PublishOptions, PublishResult } from './publisher.js';
import type { AsyncLiftPublishFailureInput } from './async-lift-publish-result.js';
import type { AsyncPreparedPublishPayload, LiftResolvedPublishSlice } from './async-lift-publish-options.js';

export interface AsyncLiftPublisher {
  lift(request: LiftRequest): Promise<string>;
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
}

export interface AsyncLiftPublishExecutionInput {
  readonly walletId: string;
  readonly publishOptions: PublishOptions;
}

export type AsyncLiftPublisherRecoveryResolver = (
  job: LiftJobBroadcast | LiftJobIncluded,
) => Promise<AsyncLiftPublisherRecoveryResult | null>;

export interface AsyncLiftPublisherConfig {
  graphUri?: string;
  maxRetries?: number;
  recoveryLookupTimeoutMs?: number;
  now?: () => number;
  idGenerator?: () => string;
  chainRecoveryResolver?: AsyncLiftPublisherRecoveryResolver;
  publishExecutor?: (input: AsyncLiftPublishExecutionInput) => Promise<PublishResult>;
  resolvedSliceOverrides?: Partial<LiftResolvedPublishSlice>;
  /**
   * Explicit encryption key used when reading authoritative private
   * quads back for deduplication in `subtractFinalizedExactQuads`. Must
   * match the key the backing `PrivateContentStore` was constructed
   * with, otherwise a non-default-key deployment will never match any
   * previously-published private quad and the lift step republishes
   * duplicates (PR #229 bot review round 9). `undefined` keeps the
   * legacy env/default resolution.
   */
  privateStoreEncryptionKey?: Uint8Array | string;
}
