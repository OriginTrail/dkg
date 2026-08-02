import type {
  CatchupConvergenceStatus,
  CatchupStatusResponse,
} from '../catchup-status-wire.js';
import {
  describeContextGraphConvergence,
  hasAuthoritativeContextGraphMetadata,
  readContextGraphReadiness,
  type ContextGraphMetadataAuthority,
  type ContextGraphReadinessStore,
} from '../context-graph-readiness.js';
import type { CatchupJob } from './types.js';

export type {
  CatchupConvergenceStatus,
  CatchupStatusResponse,
} from '../catchup-status-wire.js';

/** Project one immutable catch-up attempt plus live convergence onto the wire. */
export function toCatchupStatusResponse(
  job: CatchupJob,
  convergence?: CatchupConvergenceStatus,
): CatchupStatusResponse {
  const completedAfterAttempt = convergence?.state === 'complete' &&
    convergence.readinessUpdatedAt !== undefined &&
    job.finishedAt !== undefined &&
    convergence.readinessUpdatedAt > job.finishedAt &&
    (job.status === 'failed' ||
      job.status === 'deferred' ||
      job.status === 'unreachable');
  const invalidatedAfterAttempt = job.status === 'done' &&
    convergence !== undefined &&
    convergence.state !== 'complete' &&
    convergence.readinessUpdatedAt !== undefined &&
    job.finishedAt !== undefined &&
    convergence.readinessUpdatedAt > job.finishedAt;
  const status = completedAfterAttempt
    ? 'done'
    : invalidatedAfterAttempt
      ? 'unreachable'
      : job.status;
  const { status: attemptStatus, error: attemptError, ...attemptFields } = job;
  return {
    ...attemptFields,
    contextGraphId: job.contextGraphId,
    // `includeWorkspace` remains wire-only for pre-rename clients.
    includeWorkspace: job.includeSharedMemory,
    status,
    ...(status === attemptStatus && attemptError ? { error: attemptError } : {}),
    ...(status !== attemptStatus
      ? {
          attempt: {
            status: attemptStatus,
            ...(attemptError ? { error: attemptError } : {}),
          },
        }
      : {}),
    ...(convergence ? { convergence } : {}),
    ...(completedAfterAttempt ? { completedAfterAttempt: true } : {}),
  };
}

export interface CatchupStatusAgent extends ContextGraphMetadataAuthority {
  getSubscribedContextGraphs(): ReadonlyMap<string, {
    subscribed?: boolean;
    syncMode?: 'on-demand' | 'always-on';
  }>;
}

/** Load live convergence and apply the canonical status projection together. */
export async function loadCatchupStatusResponse(input: {
  job: CatchupJob;
  agent: CatchupStatusAgent;
  readinessStore: Partial<ContextGraphReadinessStore>;
  observedAt?: number;
}): Promise<CatchupStatusResponse> {
  const subscription = input.agent.getSubscribedContextGraphs()
    .get(input.job.contextGraphId);
  const hasConfirmedMeta = await hasAuthoritativeContextGraphMetadata({
    agent: input.agent,
    contextGraphId: input.job.contextGraphId,
  });
  const convergence: CatchupConvergenceStatus = {
    ...describeContextGraphConvergence({
      readiness: readContextGraphReadiness(
        input.readinessStore,
        input.job.contextGraphId,
      ),
      includeSharedMemory: input.job.includeSharedMemory,
      hasConfirmedMeta,
      ...(input.observedAt === undefined
        ? {}
        : { observedAt: input.observedAt }),
    }),
    syncMode: subscription?.syncMode ?? 'always-on',
    automaticRetryActive: subscription?.subscribed === true,
  };
  return toCatchupStatusResponse(input.job, convergence);
}
