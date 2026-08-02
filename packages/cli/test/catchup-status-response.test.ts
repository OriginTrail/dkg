import { describe, expect, it } from 'vitest';
import {
  toCatchupStatusResponse,
  type CatchupConvergenceStatus,
  type CatchupJob,
} from '../src/daemon/types.js';

const completeConvergence: CatchupConvergenceStatus = {
  state: 'complete',
  required: {
    metadata: true,
    durable: true,
    sharedMemory: true,
  },
  verified: {
    metadata: true,
    durable: true,
    sharedMemory: true,
  },
  missing: [],
  readinessUpdatedAt: 10,
  observedAt: 20,
  syncMode: 'on-demand',
  automaticRetryActive: true,
};

function job(status: CatchupJob['status']): CatchupJob {
  return {
    jobId: 'job-1',
    contextGraphId: 'cg-1',
    includeWorkspace: true,
    status,
    queuedAt: 1,
    startedAt: 2,
    finishedAt: 3,
    error: `${status} attempt`,
  };
}

describe('catch-up status response', () => {
  it('reports live completion while preserving a failed attempt as diagnostics', () => {
    expect(toCatchupStatusResponse(job('failed'), completeConvergence)).toMatchObject({
      status: 'done',
      attemptStatus: 'failed',
      attemptError: 'failed attempt',
      error: undefined,
      completedAfterAttempt: true,
      convergence: completeConvergence,
    });
  });

  it('never lets historical readiness override a current authorization denial', () => {
    expect(toCatchupStatusResponse(job('denied'), completeConvergence)).toMatchObject({
      status: 'denied',
      attemptStatus: 'denied',
      error: 'denied attempt',
      convergence: completeConvergence,
    });
  });
});
