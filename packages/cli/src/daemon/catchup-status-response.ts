import type {
  CatchupConvergenceStatus,
  CatchupStatusResponse,
} from '../catchup-status-wire.js';
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
    convergence.state !== 'complete';
  const status = completedAfterAttempt
    ? 'done'
    : invalidatedAfterAttempt
      ? 'unreachable'
      : job.status;
  const { status: attemptStatus, error: attemptError, ...attemptFields } = job;
  return {
    ...attemptFields,
    contextGraphId: job.contextGraphId,
    includeSharedMemory: job.includeWorkspace,
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
