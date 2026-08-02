import { describe, expect, it } from 'vitest';
import {
  lossyPublicEmptyResult,
  privateSharedMemoryOnlyResult,
} from './helpers/context-graph-catchup-fixtures.js';
import { ContextGraphSubscribeRouteHarness } from './helpers/context-graph-subscribe-route-harness.js';

async function runIncompletePrivateAttempt(
  options: { strictHasConfirmedMeta?: boolean; locallyCurated?: boolean } = {},
) {
  const harness = await ContextGraphSubscribeRouteHarness.create({
    hasConfirmedMeta: true,
    strictHasConfirmedMeta: options.strictHasConfirmedMeta,
    locallyCurated: options.locallyCurated,
    isPrivate: true,
    initial: {
      subscribed: false,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
    },
    runner: () => privateSharedMemoryOnlyResult(),
  });
  const response = await harness.postSubscribe();
  const jobId = response.body.catchup.jobId as string;
  const job = await harness.waitForJob(jobId);
  return { harness, jobId, job };
}

describe('catch-up status live convergence', () => {
  it('preserves a lossy public empty-round success without persisted completion', async () => {
    const harness = await ContextGraphSubscribeRouteHarness.create({
      hasConfirmedMeta: true,
      isPrivate: false,
      initial: {
        subscribed: false,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
      runner: () => lossyPublicEmptyResult(),
    });
    try {
      const response = await harness.postSubscribe({ includeSharedMemory: false });
      const jobId = response.body.catchup.jobId as string;
      const job = await harness.waitForJob(jobId);
      expect(job).toMatchObject({ status: 'done' });

      await expect(harness.getStatus(jobId)).resolves.toMatchObject({
        status: 'done',
        convergence: {
          state: 'partial',
          verified: {
            metadata: true,
            durable: false,
            sharedMemory: false,
          },
          missing: ['durable'],
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('keeps a failed attempt failed when complete readiness predates the job', async () => {
    const harness = await ContextGraphSubscribeRouteHarness.create({
      hasConfirmedMeta: true,
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
      readiness: {
        version: 1,
        durableVerified: true,
        sharedMemoryVerified: true,
        updatedAt: 1,
      },
      runner: () => {
        throw new Error('foreground attempt failed');
      },
    });
    try {
      const response = await harness.postSubscribe();
      const jobId = response.body.catchup.jobId as string;
      const job = await harness.waitForJob(jobId);
      expect(job?.status).toBe('failed');

      await expect(harness.getStatus(jobId)).resolves.toMatchObject({
        status: 'failed',
        error: 'foreground attempt failed',
        convergence: {
          state: 'complete',
          readinessUpdatedAt: 1,
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('reports completion after persisted readiness recovers a failed attempt', async () => {
    const { harness, jobId, job } = await runIncompletePrivateAttempt();
    try {
      expect(job?.status).toBe('unreachable');
      harness.setCompleteReadiness((job?.finishedAt ?? Date.now()) + 1);

      await expect(harness.getStatus(jobId)).resolves.toMatchObject({
        status: 'done',
        attempt: {
          status: 'unreachable',
          error: expect.stringContaining('durable VM'),
        },
        completedAfterAttempt: true,
        convergence: {
          state: 'complete',
          verified: {
            metadata: true,
            durable: true,
            sharedMemory: true,
          },
          missing: [],
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('rejects legacy placeholder metadata instead of rewriting failure to done', async () => {
    const { harness, jobId, job } = await runIncompletePrivateAttempt({
      strictHasConfirmedMeta: false,
      locallyCurated: false,
    });
    try {
      expect(job?.status).toBe('unreachable');
      harness.setCompleteReadiness((job?.finishedAt ?? Date.now()) + 1);

      await expect(harness.getStatus(jobId)).resolves.toMatchObject({
        status: 'unreachable',
        convergence: {
          state: 'pending',
          verified: {
            metadata: false,
            durable: false,
            sharedMemory: false,
          },
          missing: ['metadata', 'durable', 'sharedMemory'],
        },
      });
      expect(harness.metadataCheckOptions).toContainEqual({
        rejectUnregisteredPlaceholder: true,
      });
    } finally {
      await harness.close();
    }
  });

  it('preserves the local-curator metadata exception used by bootstrap', async () => {
    const { harness, jobId, job } = await runIncompletePrivateAttempt({
      strictHasConfirmedMeta: false,
      locallyCurated: true,
    });
    try {
      harness.setCompleteReadiness((job?.finishedAt ?? Date.now()) + 1);

      await expect(harness.getStatus(jobId)).resolves.toMatchObject({
        status: 'done',
        completedAfterAttempt: true,
        convergence: { state: 'complete', missing: [] },
      });
      expect(harness.metadataCheckOptions).toContainEqual({
        rejectUnregisteredPlaceholder: false,
      });
    } finally {
      await harness.close();
    }
  });
});
