import type { LiftJob, LiftJobBroadcast, LiftJobFinalizationMetadata, LiftJobIncluded, LiftJobInclusionMetadata, LiftJobState, LiftRequest } from './lift-job.js';
import type { PublishResult } from './publisher.js';
import type { AsyncLiftPublishFailureInput } from './async-lift-publish-result.js';

export interface AsyncLiftPublisher {
  lift(request: LiftRequest): Promise<string>;
  claimNext(walletId: string): Promise<LiftJob | null>;
  update(jobId: string, status: LiftJobState, data?: Partial<LiftJob>): Promise<void>;
  getStatus(jobId: string): Promise<LiftJob | null>;
  list(filter?: { status?: LiftJobState }): Promise<LiftJob[]>;
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

export type AsyncLiftPublisherRecoveryResolver = (
  job: LiftJobBroadcast | LiftJobIncluded,
) => Promise<AsyncLiftPublisherRecoveryResult | null>;

export interface AsyncLiftPublisherConfig {
  graphUri?: string;
  maxRetries?: number;
  now?: () => number;
  idGenerator?: () => string;
  chainRecoveryResolver?: AsyncLiftPublisherRecoveryResolver;
}
