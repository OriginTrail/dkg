import { describe, expect, it } from 'vitest';
import {
  toCatchupStatusResponse,
  type CatchupConvergenceStatus,
} from '../src/daemon/catchup-status-response.js';
import type { CatchupJob } from '../src/daemon/types.js';

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
    includeSharedMemory: true,
    status,
    queuedAt: 1,
    startedAt: 2,
    finishedAt: 3,
    error: `${status} attempt`,
  };
}

describe('catch-up status response', () => {
  it('keeps the legacy workspace name at the response boundary only', () => {
    const attempt = job('done');

    expect(attempt).toHaveProperty('includeSharedMemory', true);
    expect(attempt).not.toHaveProperty('includeWorkspace');
    expect(toCatchupStatusResponse(attempt)).toMatchObject({
      includeSharedMemory: true,
      includeWorkspace: true,
    });
  });

  it('reports live completion while preserving a failed attempt as diagnostics', () => {
    expect(toCatchupStatusResponse(job('failed'), completeConvergence)).toMatchObject({
      status: 'done',
      attempt: {
        status: 'failed',
        error: 'failed attempt',
      },
      completedAfterAttempt: true,
      convergence: completeConvergence,
    });
    expect(toCatchupStatusResponse(job('failed'), completeConvergence))
      .not.toHaveProperty('error');
  });

  it('reports newer live completion while preserving a deferred attempt as diagnostics', () => {
    expect(toCatchupStatusResponse(job('deferred'), completeConvergence)).toMatchObject({
      status: 'done',
      attempt: {
        status: 'deferred',
        error: 'deferred attempt',
      },
      completedAfterAttempt: true,
      convergence: completeConvergence,
    });
    expect(toCatchupStatusResponse(job('deferred'), completeConvergence))
      .not.toHaveProperty('error');
  });

  it('does not hide a failed attempt behind readiness that predates it', () => {
    const staleConvergence = { ...completeConvergence, readinessUpdatedAt: 3 };

    expect(toCatchupStatusResponse(job('failed'), staleConvergence)).toMatchObject({
      status: 'failed',
      error: 'failed attempt',
      convergence: staleConvergence,
    });
    expect(toCatchupStatusResponse(job('failed'), staleConvergence))
      .not.toHaveProperty('completedAfterAttempt');
    expect(toCatchupStatusResponse(job('failed'), staleConvergence))
      .not.toHaveProperty('attempt');
  });

  it('never lets historical readiness override a current authorization denial', () => {
    expect(toCatchupStatusResponse(job('denied'), completeConvergence)).toMatchObject({
      status: 'denied',
      error: 'denied attempt',
      convergence: completeConvergence,
    });
  });

  it('downgrades the actionable status when a completed attempt loses convergence', () => {
    const invalidatedConvergence = {
      ...completeConvergence,
      state: 'pending' as const,
      verified: { metadata: false, durable: false, sharedMemory: false },
      missing: ['metadata', 'durable', 'sharedMemory'] as const,
    };

    expect(toCatchupStatusResponse(job('done'), invalidatedConvergence)).toMatchObject({
      status: 'unreachable',
      attempt: { status: 'done' },
      convergence: invalidatedConvergence,
    });
  });

  it('preserves a successful attempt when incomplete convergence is not a newer invalidation', () => {
    const nonPersistedConvergence = {
      ...completeConvergence,
      state: 'partial' as const,
      verified: { metadata: true, durable: false, sharedMemory: false },
      missing: ['durable', 'sharedMemory'] as const,
      readinessUpdatedAt: undefined,
    };

    expect(toCatchupStatusResponse(job('done'), nonPersistedConvergence))
      .toMatchObject({
        status: 'done',
        convergence: nonPersistedConvergence,
      });
    expect(toCatchupStatusResponse(job('done'), nonPersistedConvergence))
      .not.toHaveProperty('attempt');
  });
});
