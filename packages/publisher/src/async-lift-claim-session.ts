import type { PublishResult } from './publisher.js';
import type { LiftJob, LiftJobState } from './lift-job.js';
import type {
  ActiveLiftJobClaim,
  ActiveLiftJobClaimSession,
} from './async-lift-publisher-types.js';

export interface ActiveLiftJobClaimTransitionBoundary {
  run<T>(transition: (current: LiftJob) => Promise<T>): Promise<T>;
}

export interface ActiveLiftJobClaimMutations {
  update(current: LiftJob, status: LiftJobState, data?: Partial<LiftJob>): Promise<void>;
  recordPublishResult(
    current: LiftJob,
    publishResult: PublishResult,
    options?: { publicByteSize?: number },
  ): Promise<LiftJob>;
  recordExecutionFailure(
    current: LiftJob,
    failedFromState: LiftJobState,
    error: unknown,
  ): Promise<LiftJob>;
}

/**
 * Claim-bound transition authority. Every operation crosses the same ownership boundary before
 * its state-specific mutation runs; callers cannot accidentally fall back to a by-id write.
 */
export class DefaultActiveLiftJobClaimSession implements ActiveLiftJobClaimSession {
  constructor(
    readonly claim: ActiveLiftJobClaim,
    private readonly boundary: ActiveLiftJobClaimTransitionBoundary,
    private readonly mutations: ActiveLiftJobClaimMutations,
  ) {}

  async update(status: LiftJobState, data: Partial<LiftJob> = {}): Promise<void> {
    await this.boundary.run(async (current) => {
      await this.mutations.update(current, status, data);
    });
  }

  async recordPublishResult(
    publishResult: PublishResult,
    options: { publicByteSize?: number } = {},
  ): Promise<LiftJob> {
    return await this.boundary.run(
      async (current) => await this.mutations.recordPublishResult(current, publishResult, options),
    );
  }

  async recordExecutionFailure(failedFromState: LiftJobState, error: unknown): Promise<LiftJob> {
    return await this.boundary.run(
      async (current) => await this.mutations.recordExecutionFailure(current, failedFromState, error),
    );
  }
}
